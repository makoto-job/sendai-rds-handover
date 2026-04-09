/* ========================================
   現場引継ぎ — Voice Input Module
   Web Speech API wrapper (Japanese)
   ======================================== */

'use strict';

const VoiceInput = {
  _recognition: null,
  _callbacks: {},
  _active: false,

  isSupported() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  },

  start(callbacks) {
    if (!this.isSupported()) {
      callbacks?.onError?.('このブラウザは音声入力に対応していません');
      return;
    }

    if (callbacks) this._callbacks = callbacks;

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    this._recognition = new SpeechRecognition();
    this._recognition.lang = 'ja-JP';
    this._recognition.continuous = true;
    this._recognition.interimResults = true;
    this._recognition.maxAlternatives = 1;

    this._recognition.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0].transcript;
        const isFinal = result.isFinal;
        this._callbacks.onResult?.(text, isFinal);
      }
    };

    this._recognition.onerror = (event) => {
      const messages = {
        'not-allowed': 'マイクの使用が許可されていません。ブラウザの設定を確認してください',
        'no-speech': '音声が検出されませんでした',
        'network': 'ネットワークエラー。オフラインでは音声入力を利用できません',
        'aborted': '音声入力が中断されました',
        'audio-capture': 'マイクが見つかりません'
      };
      const msg = messages[event.error] || `音声入力エラー (${event.error})`;

      // no-speech は自動リスタートするのでエラー通知しない
      if (event.error === 'no-speech') return;

      this._callbacks.onError?.(msg);
    };

    this._recognition.onend = () => {
      this._callbacks.onEnd?.();
    };

    try {
      this._recognition.start();
      this._active = true;
    } catch (e) {
      this._callbacks.onError?.('音声入力の開始に失敗しました');
    }
  },

  stop() {
    this._active = false;
    if (this._recognition) {
      try { this._recognition.stop(); } catch {}
      this._recognition = null;
    }
  }
};
