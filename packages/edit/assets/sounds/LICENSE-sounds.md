# Sound licences

## mouse-click-trimmed.wav

- Source: "Mouse Click Sound.mp3", https://freesound.org/s/678248/
- Author: Pixeliota (Freesound)
- Licence: Creative Commons 0 (CC0 1.0 Universal, public domain dedication),
  http://creativecommons.org/publicdomain/zero/1.0/
- Changes: converted to WAV and trimmed to the press, onset 8 ms (0.23 s long).

## camera-shutter.wav

- Source: "Camera shutter in Sony A55", https://freesound.org/s/249750/
- Author: matthiastidlund (Freesound)
- Licence: Creative Commons 0 (CC0 1.0 Universal, public domain dedication),
  http://creativecommons.org/publicdomain/zero/1.0/
- Recording: the shutter of a Sony A55 SLT camera with its 18-55 mm lens, recorded with a Zoom H2n
  (the author's description).
- Changes: from the page's high-quality preview (MP3), mixed to mono, trimmed to the shutter
  (0.022 to 0.47 s of the source), 3 ms fade in and 30 ms fade out, +9.6 dB, converted to WAV
  (44.1 kHz, 16 bit; 0.448 s long).

## whoosh.wav

- Source: "Woosh (stick swung in the air)", https://freesound.org/s/352719/
- Author: Dalesome (Freesound)
- Licence: Creative Commons 0 (CC0 1.0 Universal, public domain dedication),
  http://creativecommons.org/publicdomain/zero/1.0/
- Recording: a thin long stick swung in the air, recorded with a Rode NT1-A microphone (the
  author's description).
- Changes: from the page's high-quality preview (MP3), mixed to mono, trimmed (0.01 to 0.48 s of
  the source), 10 ms fade in and 80 ms fade out, -8.4 dB, converted to WAV (44.1 kHz, 16 bit;
  0.47 s long).

## pop.wav

- Source: "Clean pop", https://freesound.org/s/704168/
- Author: magicjoshua (Freesound)
- Licence: Creative Commons 0 (CC0 1.0 Universal, public domain dedication),
  http://creativecommons.org/publicdomain/zero/1.0/
- Recording: a pop made with the mouth (the author's description).
- Changes: from the page's high-quality preview (MP3), mixed to mono, trimmed to the pop (0.318
  to 0.47 s of the source), 3 ms fade in and 40 ms fade out, +5.3 dB, converted to WAV (44.1 kHz,
  16 bit; 0.152 s long).

## typing-key-1.wav, typing-key-2.wav, typing-key-3.wav, typing-key-4.wav

- Source: "Laptop keyboard.ogg", Wikimedia Commons,
  https://commons.wikimedia.org/wiki/File:Laptop_keyboard.ogg
  (file: https://upload.wikimedia.org/wikipedia/commons/6/67/Laptop_keyboard.ogg,
  SHA-1 aeea0229ffdb2420ed02ba2a4e351d10b4c45c29). First published on PDSounds
  (record 554, "Laptop keyboard": copy-typing on a laptop on a wooden desk, London, May 2008).
- Author: russiandoll (PDSounds)
- Licence: public domain. The author released the recording into the public domain
  (Commons templates `PD-author` and `PD-pdsounds.org`); no attribution is required.
- Changes: four single key presses cut from the recording (at 35.32 s, 35.93 s, 30.64 s and
  62.76 s), each 0.07 s long from 2 ms before the press, mono, 44.1 kHz, 16 bit, high-passed at
  200 Hz, faded in over 1 ms and out over 25 ms, its peak set to -6 dBFS.

## Levels

The shutter, the whoosh and the pop are levelled to the click: the loudest 100 ms of each has the
click's RMS (-22.8 dBFS, measured on the mono mix). The ear sums a sound's energy over about a
tenth of a second, so sounds this short are about as loud as one another when that energy is equal,
whatever their peaks: the click peaks at -0.2 dBFS (two 10 ms ticks), the shutter at -4.5, the pop
at -5.2 and the whoosh, which is steady noise, at -14.9. All four then play at the preset's one
gain (-6 dB).

The typing keys are not levelled to the click: each is a single press of 70 ms with its peak at
-6 dBFS, and the typed hook sets their gain at every build from the speaker's measured voice (the
hook entry's `soundLevel`, `packages/edit/src/sounds.ts`), from the RMS and the peak below.

The preset (`packages/edit/src/preset.ts`, `sounds`) holds each sound's whole-file RMS and peak;
`packages/edit/src/sounds.test.ts` reads the files and checks both.

| file                    | length  | peak (dBFS) | RMS, whole file (dBFS) | RMS, loudest 100 ms (dBFS) |
| ----------------------- | ------- | ----------- | ---------------------- | -------------------------- |
| mouse-click-trimmed.wav | 0.23 s  | -0.2        | -26.4                  | -22.8                      |
| camera-shutter.wav      | 0.448 s | -4.5        | -26.2                  | -22.8                      |
| whoosh.wav              | 0.47 s  | -14.9       | -29.4                  | -22.8                      |
| pop.wav                 | 0.152 s | -5.2        | -24.6                  | -22.8                      |
| typing-key-1 to 4.wav   | 0.07 s  | -6.0        | -26.3 (mean power)     | not levelled               |
