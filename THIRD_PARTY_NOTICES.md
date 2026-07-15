# Third-party notices

## Unicode Character Database case-fold data

`shared/unicodeCaseFold.generated.ts` is generated from Unicode 17.0.0
`CaseFolding.txt`, published by Unicode, Inc. The source version and date are
embedded in the generated file. The Unicode Data Files and Software License is
available at https://www.unicode.org/license.txt and permits use, copying,
modification and distribution when the copyright and permission notice remain.

Copyright © 1991–2025 Unicode, Inc. All rights reserved.

---

## World Cup 2026 fixture/result dataset

The optional `football_data` development provider reads the 2026 JSON dataset
from [upbound-web/worldcup-live.json](https://github.com/upbound-web/worldcup-live.json).
The upstream project describes the football data as public domain under CC0.
No copy of the dataset is committed or redistributed by this repository; it is
fetched at runtime from the fixed upstream HTTPS location. Attribution and a
source link are retained in every grounded chat response even though CC0 does
not require attribution.

The source is a community-maintained dataset, not an official FIFA feed and not
a contractual real-time data service. Verify its current license and usage
terms before bundling, mirroring or commercially redistributing the data.

---

## Optional Piper TTS runtime and Swedish voices

`npm run setup:tts` optionally downloads `piper-tts==1.4.2` into the ignored,
isolated `.venv-tts` directory. Piper is licensed under GPL-3.0-or-later. It is
run as an independent loopback HTTP sidecar and is not linked into or
redistributed with the Node application. Source and license information:
https://github.com/OHF-Voice/piper1-gpl

The setup also pins `onnxruntime==1.24.4`, `pathvalidate==3.3.1` and
`numpy==2.4.4` as a verified compatibility set. Other transitive Python
dependencies are resolved at installation time and are not yet protected by a
cross-platform hash lock.

The setup script also downloads Lisa and NST Swedish ONNX voice assets from
`rhasspy/piper-voices` at immutable revision
`e21c7de8d4eab79b902f0d61e662b3f21664b8d2`. The upstream repository declares
MIT metadata. NST's model card names a CC0 dataset. Lisa's model card documents
its Norwegian talesyntese fine-tune provenance but does not state an explicit
dataset/model license. The assets are not committed or bundled; review their
downloaded `MODEL_CARD` files before redistribution. Exact URLs, byte sizes and
SHA-256 digests are documented in `docs/local-piper-tts.md`.

---

The inline SVG icon geometry in `src/App.tsx` is based on icons from
[Lucide](https://lucide.dev/). Lucide is distributed under the ISC License;
some Lucide icons are derived from the Feather project under the MIT License.

## Lucide — ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY
SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION
OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN
CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

## Feather-derived icons — MIT License

Copyright (c) 2013-present Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
