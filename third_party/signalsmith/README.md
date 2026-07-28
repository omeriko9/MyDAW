# signalsmith-stretch (vendored)

High-quality spectral time-stretch / pitch-shift by Signalsmith Audio, used by
`engine/src/media/TimeStretch.cpp` (`spectralStretch`) for `cmd/clip.stretch`.

- `signalsmith-stretch.h` — https://github.com/Signalsmith-Audio/signalsmith-stretch
  (main branch, fetched 2026-07-28) — MIT, see `LICENSE-signalsmith-stretch.txt`
- `signalsmith-linear/` — https://github.com/Signalsmith-Audio/linear
  (main branch, fetched 2026-07-28) — MIT, see `LICENSE-signalsmith-linear.txt`.
  Only the headers are vendored; the optional accelerated FFT backends
  (`platform/`, enabled via SIGNALSMITH_USE_* defines) are included but unused —
  the plain C++ path compiles everywhere.

Local layout note: `signalsmith-stretch.h` includes `"signalsmith-linear/stft.h"`
relative to its own directory, so the two must stay siblings as laid out here.
No other changes were made to the sources.
