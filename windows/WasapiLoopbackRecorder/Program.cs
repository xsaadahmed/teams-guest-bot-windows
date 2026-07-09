using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using NAudio.CoreAudioApi;
using NAudio.MediaFoundation;
using NAudio.Wave;
using NAudio.Wave.SampleProviders;

namespace WasapiLoopbackRecorder
{
    /// <summary>
    /// Records TWO things and mixes them together, same as Meetily's "professional audio
    /// mixing" and analogous to what you'd get recording a phone call from both ends:
    ///
    ///  1. Loopback capture on whatever render device(s) Chromium/Teams WebRTC plays remote
    ///     participants through - the Linux virtual_speaker.monitor equivalent.
    ///  2. A genuine microphone capture - because loopback can only ever contain audio that
    ///     was actually PLAYED by the bot's Chromium tab, and nobody's own voice is ever
    ///     played back to them (every conferencing system suppresses your own audio echoing
    ///     back to you) - the render side is fundamentally the wrong place to ever find your
    ///     own voice, joined via your own Teams client or not.
    ///
    /// The two are resampled independently to 16kHz mono, then summed (not averaged) into one
    /// final WAV - averaging would quietly get quieter every time Windows happens to expose an
    /// extra render-device role, which has nothing to do with how loud either your voice or
    /// the meeting actually is.
    ///
    /// Usage:
    ///   WasapiLoopbackRecorder.exe &lt;output.wav&gt; [--device &lt;render-endpoint-id&gt;]
    ///                                              [--mic-device &lt;capture-endpoint-id&gt;]
    ///                                              [--no-mic] [--mic-gated]
    /// Control: write "STOP" to stdin (or close it). With --mic-gated, also accepts
    /// "MIC 0" / "MIC 1" to close/open the mic contribution while loopback continues.
    /// Prints "READY" when capture has started.
    /// </summary>
    internal static class Program
    {
        private static readonly WaveFormat TargetFormat = new WaveFormat(16000, 16, 1);

        [STAThread]
        private static int Main(string[] args)
        {
            if (args.Length < 1 || args[0].StartsWith("--", StringComparison.Ordinal))
            {
                PrintUsage();
                return 2;
            }

            string outputPath = Path.GetFullPath(args[0]);
            string? renderDeviceId = null;
            string? micDeviceId = null;
            bool noMic = false;
            bool micGated = false;

            for (int i = 1; i < args.Length; i++)
            {
                if (string.Equals(args[i], "--device", StringComparison.OrdinalIgnoreCase) && i + 1 < args.Length)
                {
                    renderDeviceId = args[++i];
                }
                else if (string.Equals(args[i], "--mic-device", StringComparison.OrdinalIgnoreCase) && i + 1 < args.Length)
                {
                    micDeviceId = args[++i];
                }
                else if (string.Equals(args[i], "--no-mic", StringComparison.OrdinalIgnoreCase))
                {
                    noMic = true;
                }
                else if (string.Equals(args[i], "--mic-gated", StringComparison.OrdinalIgnoreCase))
                {
                    micGated = true;
                }
                else
                {
                    Console.Error.WriteLine($"[wasapi] Unknown argument: {args[i]}");
                    PrintUsage();
                    return 2;
                }
            }

            string? outDir = Path.GetDirectoryName(outputPath);
            if (!string.IsNullOrEmpty(outDir))
            {
                Directory.CreateDirectory(outDir);
            }

            List<MMDevice> renderDevices;
            try
            {
                renderDevices = GetLoopbackRenderDevices(renderDeviceId);
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[wasapi] Could not open an audio render device: {ex.Message}");
                return 1;
            }

            foreach (var device in renderDevices)
            {
                Console.Error.WriteLine($"[wasapi] Looping back (remote/meeting audio): {device.FriendlyName} ({device.ID})");
            }

            var loopbackSessions = new List<CaptureSession>();
            foreach (var device in renderDevices)
            {
                string tempPath = outputPath + $".loopback.{loopbackSessions.Count}.tmp.wav";
                loopbackSessions.Add(new CaptureSession(new WasapiLoopbackCapture(device), tempPath, device));
            }

            CaptureSession? micSession = null;
            if (!noMic)
            {
                MMDevice? micDevice = TryGetMicDevice(micDeviceId);
                if (micDevice != null)
                {
                    Console.Error.WriteLine($"[wasapi] Capturing microphone (your voice): {micDevice.FriendlyName} ({micDevice.ID})");
                    try
                    {
                        var micCapture = new WasapiCapture(micDevice) { ShareMode = AudioClientShareMode.Shared };
                        micSession = new CaptureSession(micCapture, outputPath + ".mic.tmp.wav", micDevice);
                    }
                    catch (Exception ex)
                    {
                        Console.Error.WriteLine($"[wasapi] Could not open microphone for capture ({ex.Message}) - continuing without it.");
                        micDevice.Dispose();
                    }
                }
                else
                {
                    Console.Error.WriteLine("[wasapi] No microphone found - continuing without it (recording will only contain remote/meeting audio).");
                }
            }
            else
            {
                Console.Error.WriteLine("[wasapi] --no-mic given - recording will only contain remote/meeting audio.");
            }

            int micGateOpen = 1;
            if (micSession != null && micGated)
            {
                Console.Error.WriteLine("[wasapi] Mic capture is mute-gated (open by default; send MIC 0 on stdin to silence while muted).");
            }

            var allSessions = new List<CaptureSession>(loopbackSessions);
            if (micSession != null) allSessions.Add(micSession);

            var stopSignal = new ManualResetEventSlim(false);
            var finalizeGate = new object();
            bool finalized = false;
            int pendingStops = allSessions.Count;

            void OnStreamStopped(CaptureSession session, StoppedEventArgs a)
            {
                if (a.Exception != null)
                {
                    Console.Error.WriteLine($"[wasapi] Capture stopped with an error ({session.Label}): {a.Exception.Message}");
                }
                session.Writer?.Dispose();
                session.Writer = null;
                if (Interlocked.Decrement(ref pendingStops) == 0)
                {
                    FinalizeRecording(
                        finalizeGate,
                        ref finalized,
                        loopbackSessions.Select(s => s.TempPath).ToList(),
                        micSession?.TempPath,
                        outputPath);
                    stopSignal.Set();
                }
            }

            foreach (var session in allSessions)
            {
                bool isMicSession = micSession != null && ReferenceEquals(session, micSession);
                session.Capture.DataAvailable += (_, a) =>
                {
                    if (a.BytesRecorded <= 0) return;
                    session.Writer ??= new WaveFileWriter(session.TempPath, session.Capture.WaveFormat);
                    if (isMicSession && micGated && Volatile.Read(ref micGateOpen) == 0)
                    {
                        session.Writer.Write(new byte[a.BytesRecorded], 0, a.BytesRecorded);
                        return;
                    }
                    session.Writer.Write(a.Buffer, 0, a.BytesRecorded);
                };
                session.Capture.RecordingStopped += (_, a) => OnStreamStopped(session, a);
            }

            Console.CancelKeyPress += (_, a) =>
            {
                a.Cancel = true;
                Console.Error.WriteLine("[wasapi] Ctrl+C received, stopping...");
                StopAll(allSessions);
            };

            try
            {
                foreach (var session in allSessions)
                {
                    session.Capture.StartRecording();
                }
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[wasapi] Failed to start capture: {ex.Message}");
                foreach (var session in allSessions)
                {
                    session.Dispose();
                }
                return 1;
            }

            Console.Error.WriteLine("[wasapi] Recording started. Send \"STOP\" on stdin (or close it) to finish.");
            Console.WriteLine("READY");

            string? line;
            while ((line = Console.In.ReadLine()) != null)
            {
                string trimmed = line.Trim();
                if (trimmed.Equals("STOP", StringComparison.OrdinalIgnoreCase))
                {
                    break;
                }
                if (trimmed.Equals("MIC 0", StringComparison.OrdinalIgnoreCase))
                {
                    Volatile.Write(ref micGateOpen, 0);
                    continue;
                }
                if (trimmed.Equals("MIC 1", StringComparison.OrdinalIgnoreCase))
                {
                    Volatile.Write(ref micGateOpen, 1);
                    continue;
                }
            }

            Console.Error.WriteLine("[wasapi] Stop requested, finalizing...");
            StopAll(allSessions);

            if (!stopSignal.Wait(TimeSpan.FromSeconds(15)))
            {
                Console.Error.WriteLine("[wasapi] Timed out waiting for capture to stop cleanly; finalizing anyway.");
                foreach (var session in allSessions)
                {
                    session.Writer?.Dispose();
                }
                FinalizeRecording(
                    finalizeGate,
                    ref finalized,
                    loopbackSessions.Select(s => s.TempPath).ToList(),
                    micSession?.TempPath,
                    outputPath);
            }

            foreach (var session in allSessions)
            {
                session.Dispose();
            }

            return 0;
        }

        private sealed class CaptureSession : IDisposable
        {
            public string Label { get; }
            public string TempPath { get; }
            public IWaveIn Capture { get; }
            public WaveFileWriter? Writer { get; set; }
            private readonly MMDevice _device;

            public CaptureSession(IWaveIn capture, string tempPath, MMDevice device)
            {
                Capture = capture;
                TempPath = tempPath;
                _device = device;
                Label = device.FriendlyName;
            }

            public void Dispose()
            {
                Capture.Dispose();
                _device.Dispose();
            }
        }

        private static void StopAll(IEnumerable<CaptureSession> sessions)
        {
            foreach (var session in sessions)
            {
                try { session.Capture.StopRecording(); }
                catch (Exception ex)
                {
                    Console.Error.WriteLine($"[wasapi] Stop failed ({session.Label}): {ex.Message}");
                }
            }
        }

        private static void PrintUsage()
        {
            Console.Error.WriteLine(
                "Usage: WasapiLoopbackRecorder.exe <output.wav> [--device <render-endpoint-id>] " +
                "[--mic-device <capture-endpoint-id>] [--no-mic] [--mic-gated]");
        }

        private static List<MMDevice> GetLoopbackRenderDevices(string? deviceId)
        {
            var enumerator = new MMDeviceEnumerator();
            if (!string.IsNullOrEmpty(deviceId))
            {
                return new List<MMDevice> { enumerator.GetDevice(deviceId) };
            }

            var devices = new List<MMDevice>();
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (Role role in new[] { Role.Communications, Role.Multimedia, Role.Console })
            {
                try
                {
                    MMDevice device = enumerator.GetDefaultAudioEndpoint(DataFlow.Render, role);
                    if (seen.Add(device.ID))
                    {
                        devices.Add(device);
                    }
                    else
                    {
                        device.Dispose();
                    }
                }
                catch
                {
                    // role not configured on this machine
                }
            }

            if (devices.Count == 0)
            {
                throw new InvalidOperationException("No default render device found for loopback capture.");
            }

            return devices;
        }

        private static MMDevice? TryGetMicDevice(string? micDeviceId)
        {
            var enumerator = new MMDeviceEnumerator();
            if (!string.IsNullOrEmpty(micDeviceId))
            {
                try { return enumerator.GetDevice(micDeviceId); }
                catch (Exception ex)
                {
                    Console.Error.WriteLine($"[wasapi] Could not open requested mic device {micDeviceId}: {ex.Message}");
                    return null;
                }
            }

            foreach (Role role in new[] { Role.Communications, Role.Multimedia })
            {
                try { return enumerator.GetDefaultAudioEndpoint(DataFlow.Capture, role); }
                catch { /* try next role / no capture device configured for it */ }
            }
            return null;
        }

        private static void FinalizeRecording(
            object gate,
            ref bool finalized,
            IReadOnlyList<string> loopbackTemps,
            string? micTemp,
            string outputPath)
        {
            lock (gate)
            {
                if (finalized) return;
                finalized = true;

                var allTemps = new List<string>(loopbackTemps);
                if (micTemp != null) allTemps.Add(micTemp);

                var loopbackSamples = new List<float[]>();
                foreach (string temp in loopbackTemps)
                {
                    if (File.Exists(temp) && new FileInfo(temp).Length > 44)
                    {
                        loopbackSamples.Add(ResampleToMono16kSamples(temp));
                    }
                }

                float[]? micSamples = null;
                if (micTemp != null && File.Exists(micTemp) && new FileInfo(micTemp).Length > 44)
                {
                    micSamples = ResampleToMono16kSamples(micTemp);
                }

                if (loopbackSamples.Count == 0 && micSamples == null)
                {
                    Console.Error.WriteLine(
                        "[wasapi] No audio was captured at all (nothing played, and no mic audio) - " +
                        "writing an empty target WAV so downstream steps still have a valid file.");
                    using var empty = new WaveFileWriter(outputPath, TargetFormat);
                    CleanupTemp(allTemps);
                    return;
                }

                try
                {
                    float[]? remote = loopbackSamples.Count > 0 ? MixMany(loopbackSamples) : null;
                    float[] final = CombineRemoteAndMic(remote, micSamples);
                    WriteMono16kWav(outputPath, final);
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine(
                        $"[wasapi] Resample/mix failed ({ex.Message}); falling back to the first available stream.");
                    string? fallback = loopbackTemps.FirstOrDefault(File.Exists) ?? micTemp;
                    if (!string.IsNullOrEmpty(fallback) && File.Exists(fallback))
                    {
                        try { ResampleToTarget(fallback, outputPath); }
                        catch { File.Copy(fallback, outputPath, overwrite: true); }
                    }
                }
                finally
                {
                    CleanupTemp(allTemps);
                }

                Console.Error.WriteLine($"[wasapi] Wrote {outputPath}");
            }
        }

        private static float[] CombineRemoteAndMic(float[]? remote, float[]? mic)
        {
            if (remote == null) return mic!;
            if (mic == null) return remote;

            int len = Math.Max(remote.Length, mic.Length);
            var combined = new float[len];
            for (int i = 0; i < len; i++)
            {
                float r = i < remote.Length ? remote[i] : 0f;
                float m = i < mic.Length ? mic[i] : 0f;
                combined[i] = Math.Clamp(r + m, -1f, 1f);
            }
            return combined;
        }

        private static void CleanupTemp(IEnumerable<string> paths)
        {
            foreach (string path in paths)
            {
                try { File.Delete(path); } catch { /* best effort */ }
            }
        }

        private static float[] MixMany(IReadOnlyList<float[]> streams)
        {
            if (streams.Count == 1) return streams[0];

            int len = streams.Max(s => s.Length);
            var mixed = new float[len];
            for (int i = 0; i < len; i++)
            {
                float sum = 0f;
                int count = 0;
                foreach (float[] stream in streams)
                {
                    if (i >= stream.Length) continue;
                    sum += stream[i];
                    count++;
                }
                mixed[i] = count > 0 ? Math.Clamp(sum / count, -1f, 1f) : 0f;
            }
            return mixed;
        }

        private static float[] ResampleToMono16kSamples(string sourcePath)
        {
            using var reader = new WaveFileReader(sourcePath);
            ISampleProvider sampleProvider = reader.ToSampleProvider();

            if (sampleProvider.WaveFormat.Channels > 1)
            {
                sampleProvider = new StereoToMonoSampleProvider(sampleProvider)
                {
                    LeftVolume = 0.5f,
                    RightVolume = 0.5f,
                };
            }

            IWaveProvider pcm16 = new SampleToWaveProvider16(sampleProvider);

            MediaFoundationApi.Startup();
            try
            {
                using var resampler = new MediaFoundationResampler(pcm16, TargetFormat) { ResamplerQuality = 60 };
                var samples = new List<float>(1024 * 64);
                var buffer = new float[4096];
                ISampleProvider output = resampler.ToSampleProvider();
                int read;
                while ((read = output.Read(buffer, 0, buffer.Length)) > 0)
                {
                    for (int i = 0; i < read; i++)
                    {
                        samples.Add(buffer[i]);
                    }
                }
                return samples.ToArray();
            }
            finally
            {
                MediaFoundationApi.Shutdown();
            }
        }

        private static void WriteMono16kWav(string path, float[] samples)
        {
            using var writer = new WaveFileWriter(path, TargetFormat);
            var sampleBytes = new byte[2];
            foreach (float sample in samples)
            {
                short value = (short)(Math.Clamp(sample, -1f, 1f) * 32767f);
                BitConverter.TryWriteBytes(sampleBytes, value);
                writer.Write(sampleBytes, 0, 2);
            }
        }

        private static void ResampleToTarget(string sourcePath, string destPath)
        {
            using var reader = new WaveFileReader(sourcePath);
            ISampleProvider sampleProvider = reader.ToSampleProvider();

            if (sampleProvider.WaveFormat.Channels > 1)
            {
                sampleProvider = new StereoToMonoSampleProvider(sampleProvider)
                {
                    LeftVolume = 0.5f,
                    RightVolume = 0.5f,
                };
            }

            IWaveProvider pcm16 = new SampleToWaveProvider16(sampleProvider);

            MediaFoundationApi.Startup();
            try
            {
                using var resampler = new MediaFoundationResampler(pcm16, TargetFormat) { ResamplerQuality = 60 };
                WaveFileWriter.CreateWaveFile(destPath, resampler);
            }
            finally
            {
                MediaFoundationApi.Shutdown();
            }
        }
    }
}
