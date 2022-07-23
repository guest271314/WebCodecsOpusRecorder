class WebCodecsOpusRecorder {
  constructor(track) {
    const processor = new MediaStreamTrackProcessor({ track });
    const metadata = { offsets: [] }, // Opus packet offsets
      blob = new Blob(),
      config = {
        numberOfChannels: 1,
        sampleRate: 48000,
        codec: 'opus',
      };
    this.isConfigured = false;
    Object.assign(this, { track, processor, metadata, blob, config });
  }
  async start() {
    this.processor.readable
      .pipeTo(
        new WritableStream({
          write: async (frame) => {
            if (!this.isConfigured && frame.numberOfChannels !== this.config.numberOfChannels) {
              this.config.numberOfChannels = frame.numberOfChannels;
              this.config.format = frame.format;
              this.config.sampleRate = frame.sampleRate;
              console.log(await AudioEncoder.isConfigSupported(this.config), frame);
              this.encoder.configure(this.config);
              this.isConfigured = true;
            }
            this.encoder.encode(frame);
          },
          close() {
            console.log('Processor closed');
          },
        })
      )
      .catch(console.warn);
    this.encoder = new AudioEncoder({
      error(e) {
        console.log(e);
      },
      output: async (chunk, { decoderConfig } = {}) => {
        if (decoderConfig) {
          decoderConfig.description = btoa(
            String.fromCharCode(...new Uint8Array(decoderConfig.description))
          );
          Object.assign(this.metadata, { decoderConfig });
          console.log(this.metadata);
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
    await this.encoder.flush();
    const json = JSON.stringify(this.metadata);
    const length = Uint32Array.of(json.length); // JSON configuration length
    this.blob = new Blob([length, json, this.blob], {
      type: 'application/octet-stream',
    });
    console.log(URL.createObjectURL(this.blob));
    const handle = await showSaveFilePicker({
      startIn: 'music',
      suggestedName: `recording_${new Date().getTime()}.opus.webcodecs`,
    });
    const writable = await handle.createWritable();
    await this.blob.stream().pipeTo(writable);
  }
}
class WebCodecsOpusMediaSource {
  constructor(source) {
    this.buffer = source;
    const view = new DataView(this.buffer);
    const length = view.getUint32(0, true); 
    const json = new TextDecoder().decode(
      new Uint8Array(this.buffer).subarray(4, length + 4)
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
      )
    ).buffer;
    this.audio = new Audio();
    this.audio.controls = true;
    for (const event of [
      'loadedmetadata',
      'play',
      'pause',
      'waiting',
      'ended',
    ]) {
      this.audio.addEventListener(event, (e) => {
        console.log(e.type, this.audio.currentTime);       
      });
    }
    document.body.appendChild(this.audio);
    this.ms = new MediaSource();
    this.ms.addEventListener(
      'sourceopen',
      async () => {
        URL.revokeObjectURL(this.audio.src);
        const sourceBuffer = this.ms.addSourceBuffer({
          audioConfig: this.config.decoderConfig,
        });
        sourceBuffer.mode = 'sequence';
        for (const offset of this.config.offsets) {
          const eac = new EncodedAudioChunk({
            type: 'key',
            timestamp: this.timestamp,
            duration: !this.index ? 53500 : this.duration,
            data: this.data.subarray(this.index, this.index + offset),
          });
          await sourceBuffer.appendEncodedChunks(eac);
          this.timestamp += this.duration;
          this.index += offset;
        }
      },
      { once: true }
    );
    this.audio.src = URL.createObjectURL(this.ms);
    this.audio.play();
  }
}
export {WebCodecsOpusRecorder, WebCodecsOpusMediaSource};
