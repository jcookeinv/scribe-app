// AudioWorklet that forwards raw microphone samples to the app in blocks of 2048.
class PcmTap extends AudioWorkletProcessor {
  constructor(){
    super();
    this.buf = new Float32Array(2048);
    this.n = 0;
  }
  process(inputs){
    var input = inputs[0];
    var ch = input && input[0];
    if (ch){
      for (var i = 0; i < ch.length; i++){
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length){
          this.port.postMessage(this.buf.slice(0));
          this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('pcm-tap', PcmTap);
