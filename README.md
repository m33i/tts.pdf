# tts.pdf

small text-to-speech PDF reader using Piper voices: [ttspdf.com](https://ttspdf.com/)

drop a PDF and it is read aloud with neural voices that run in your browser. the file never leaves your device.

## what it does

- detects the language and picks a voice for it (you can also pick one)
- highlights the sentence being read, click one to jump to it
- remembers where you left off

## how it works

- [pdf.js](https://mozilla.github.io/pdf.js/) extracts the text
- [franc](https://github.com/wooorm/franc) detects the language
- [piper-tts-web](https://github.com/Mintplex-Labs/piper-tts-web) runs the [Piper](https://github.com/rhasspy/piper) voices with onnxruntime, downloaded on first use
