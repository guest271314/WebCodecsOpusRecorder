class WebCodecsOpusRecorder {
  constructor(track) {
    const processor = new MediaStreamTrackProcessor({
      track,
    });
    const metadata = {
        offsets: [], // Opus packet offsets
      },
      blob = new Blob(),
      config = {
        numberOfChannels: 1,
        sampleRate: 48000,
        codec: "opus",
      };
    this.isConfigured = false;
    Object.assign(this, {
      track,
      processor,
      metadata,
      blob,
      config,
    });
  }
  async start() {
    this.processor.readable
      .pipeTo(
        new WritableStream({
          write: async (frame) => {
            if (!this.isConfigured) {
              this.config.numberOfChannels = frame.numberOfChannels;
              this.config.sampleRate = frame.sampleRate;
              console.log(
                await AudioEncoder.isConfigSupported(this.config),
                frame,
              );
              this.encoder.configure(this.config);
              this.isConfigured = true;
            }
            this.encoder.encode(frame);
          },
          close() {
            console.log("Processor closed");
          },
        }),
      )
      .catch(console.warn);
    let firstEncodedChunk = false;
    this.encoder = new AudioEncoder({
      error(e) {
        console.log(e);
      },
      output: async (chunk, { decoderConfig } = {}) => {
        if (decoderConfig) {
          decoderConfig.description = btoa(
            String.fromCharCode(...new Uint8Array(decoderConfig.description)),
          );
          Object.assign(this.metadata, {
            decoderConfig,
          });
          console.log(this.metadata);
        }
        if (!firstEncodedChunk) {
          console.log(chunk, this.config);
          firstEncodedChunk = true;
        }
        const { byteLength } = chunk;
        this.metadata.offsets.push(byteLength);
        const ab = new ArrayBuffer(byteLength);
        chunk.copyTo(ab);
        this.blob = new Blob([this.blob, ab]);
      },
    });

    this.encoder.configure(this.config);
  }
  async stop() {
    this.track.stop();
    console.log(this.track);
    await this.encoder.flush();
    const json = JSON.stringify(this.metadata);
    console.log("stop", this.metadata);
    const length = Uint32Array.of(json.length); // JSON configuration length
    this.blob = new Blob([length, json, this.blob], {
      type: "application/octet-stream",
    });
    console.log(URL.createObjectURL(this.blob));
    try {
      const handle = await showSaveFilePicker({
        startIn: "music",
        suggestedName: `recording.opus.webcodecs`,
      });
      const writable = await handle.createWritable();
      await this.blob.stream().pipeTo(writable);
    } catch (e) {
      console.warn(e);
    }
  }
}
class WebCodecsOpusPlayer {
  constructor(source, { type = "mediaSource" } = {}) {
    this.buffer = source;
    this.type = type;
    const view = new DataView(this.buffer);
    const length = view.getUint32(0, true);
    const json = new TextDecoder().decode(
      new Uint8Array(this.buffer).subarray(4, length + 4),
    );
    this.config = JSON.parse(json);
    console.log(this.config);
    this.data = new Uint8Array(this.buffer).subarray(json.length + 4);
    this.index = 0;
    this.timestamp = 0;
    this.duration = 60000;
    this.config.decoderConfig.description = new Uint8Array(
      [...atob(this.config.decoderConfig.description)].map((s) =>
        s.charCodeAt()
      ),
    ).buffer;
  }
  async play() {
    this.audio = new Audio();
    this.audio.controls = true;
    const events = [
      "loadedmetadata",
      "loadeddata",
      "canplay",
      "canplaythrough",
      "play",
      "playing",
      "pause",
      "waiting",
      "progress",
      "seeking",
      "seeked",
      "ended",
      "stalled",
      "timeupdate",
    ];
    for (const event of events) {
      this.audio.addEventListener(event, async (e) => {
        if (this.type === "mediaSource") {
          if (this.ms.readyState === "open") {
            if (
              this.ms.activeSourceBuffers.length &&
              !this.ms.activeSourceBuffers[0].updating &&
              e.type === "timeupdate" &&
              this.audio.currentTime > 0
            ) {
              this.ms.activeSourceBuffers[0].timestampOffset =
                this.audio.currentTime;
            }
            if (e.type === "waiting" && this.audio.currentTime > 0) {
              console.log(
                e.type,
                this.audio.currentTime,
                this.ms.activeSourceBuffers[0].timestampOffset,
              );
              this.ms.activeSourceBuffers[0].timestampOffset = 0;
              // this.audio.currentTime = 0;
              // this.ms.endOfStream();
            }
            if (e.type === "ended") {
              // this.audio.currentTime = 0;
            }
            if (e.type === "loadedmetadata") {
              console.log(e.type);
              await this.audio.play();
            }
          }
        } else {
          if (this.type === "wav" && e.type !== "timeupdate") {
            console.log(e.type);
          }
        }
      });
    }
    document.body.appendChild(this.audio);
    if (this.type === "mediaSource") {
      this.ms = new MediaSource();
      this.ms.addEventListener("sourceopen", async (e) => {
        console.log(e.type);
        URL.revokeObjectURL(this.audio.src);
        const sourceBuffer = this.ms.addSourceBuffer({
          audioConfig: this.config.decoderConfig,
        });
        console.log(this.ms.activeSourceBuffers);
        sourceBuffer.onupdate = (e) => console.log(e.type);
        sourceBuffer.mode = "sequence";
        for (const offset of this.config.offsets) {
          const eac = new EncodedAudioChunk({
            type: "key",
            timestamp: this.timestamp,
            duration: !this.index ? 53500 : this.duration,
            data: this.data.subarray(this.index, this.index + offset),
          });
          await sourceBuffer.appendEncodedChunks(eac);
          this.timestamp += eac.duration;
          this.index += offset;
        }
      });
      this.audio.src = URL.createObjectURL(this.ms);
    } else {
      if (this.type === "wav") {
        const wav = new WavAudioEncoder({
          numberOfChannels: this.config.decoderConfig.numberOfChannels,
          sampleRate: this.config.decoderConfig.sampleRate,
        });
        let start = false;
        const decoder = new AudioDecoder({
          error(e) {
            console.error(e);
          },
          async output(frame) {
            const size = frame.allocationSize({
              planeIndex: 0,
            });
            const chunk = new ArrayBuffer(size);
            frame.copyTo(chunk, {
              planeIndex: 0,
            });
            wav.write(chunk);
          },
        });
        console.log(
          await AudioDecoder.isConfigSupported(this.config.decoderConfig),
        );
        decoder.configure(this.config.decoderConfig);
        this.index = 0;
        this.timestamp = 0;
        this.duration = 60000;
        for (const offset of this.config.offsets) {
          const eac = new EncodedAudioChunk({
            type: "key",
            timestamp: this.timestamp,
            duration: !this.index ? 53500 : this.duration,
            data: this.data.subarray(this.index, this.index + offset),
          });
          decoder.decode(eac);
          this.timestamp += eac.duration;
          this.index += offset;
        }
        await decoder.flush();
        const data = await wav.encode();
        this.audio.src = URL.createObjectURL(data);
      }
    }

    if (
      this.config.mediaSessionMetadata &&
      Object.values(this.config.mediaSessionMetadata).length
    ) {
      navigator.mediaSession.metadata = new MediaMetadata(
        this.config.mediaSessionMetadata,
      );
    }
  }
}
// https://github.com/higuma/wav-audio-encoder-js
class WavAudioEncoder {
  constructor({ sampleRate, numberOfChannels }) {
    let controller;
    let readable = new ReadableStream({
      start(c) {
        return (controller = c);
      },
    });
    Object.assign(this, {
      sampleRate,
      numberOfChannels,
      numberOfSamples: 0,
      dataViews: [],
      controller,
      readable,
    });
  }
  write(buffer) {
    let channels;
    // ArrayBuffer, WebCodecs AudioData f32 format
    if (buffer instanceof ArrayBuffer) {
      const floats = new Float32Array(buffer);
      // Deinterleave
      channels = this.numberOfChannels === 2
        ? Object.values(
          Object.groupBy(floats, (_, i) => i % 2),
        )
        : [floats];
    }
    // Web Audio API AudioBuffer
    if (buffer instanceof AudioBuffer) {
      channels = Array.from(
        {
          length: buffer.numberOfChannels,
        },
        (_, i) => buffer.getChannelData(i),
      );
    }
    const [{ length }] = channels;
    const ab = new ArrayBuffer(length * this.numberOfChannels * 2);
    const data = new DataView(ab);
    let offset = 0;
    for (let i = 0; i < length; i++) {
      for (let ch = 0; ch < this.numberOfChannels; ch++) {
        let x = channels[ch][i] * 0x7fff;
        data.setInt16(
          offset,
          x < 0 ? Math.max(x, -0x8000) : Math.min(x, 0x7fff),
          true,
        );
        offset += 2;
      }
    }
    this.controller.enqueue(new Uint8Array(ab));
    this.numberOfSamples += length;
  }
  setString(view, offset, str) {
    const len = str.length;
    for (let i = 0; i < len; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  }
  async encode() {
    const dataSize = this.numberOfChannels * this.numberOfSamples * 2;
    const buffer = new ArrayBuffer(44);
    const view = new DataView(buffer);
    this.setString(view, 0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    this.setString(view, 8, "WAVE");
    this.setString(view, 12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, this.numberOfChannels, true);
    view.setUint32(24, this.sampleRate, true);
    view.setUint32(28, this.sampleRate * 4, true);
    view.setUint16(32, this.numberOfChannels * 2, true);
    view.setUint16(34, 16, true);
    this.setString(view, 36, "data");
    view.setUint32(40, dataSize, true);
    this.controller.close();
    return new Blob(
      [
        buffer,
        await new Response(this.readable, {
          cache: "no-store",
        }).arrayBuffer(),
      ],
      {
        type: "audio/wav",
      },
    );
  }
}
export { WavAudioEncoder, WebCodecsOpusPlayer, WebCodecsOpusRecorder };
