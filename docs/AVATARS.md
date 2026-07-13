# Resident avatar production

The twenty resident portraits are original, AI-generated images of entirely fictional adults. They are not photographs of real community members and were created without celebrity or other real-person references.

## Shared production prompt

Every portrait used the same production frame, followed by a character-specific visual brief:

> Square 1:1 head-and-shoulders profile portrait of one fictional adult community member. Photorealistic candid editorial photography, natural skin texture and small imperfections, ordinary contemporary clothing, an intimate dark community space with restrained practical light in that resident's established colours, shallow depth of field, face large and centred for clear reading at 32px, crop-safe margins, coherent subdued colour grading and approachable community-avatar energy. No glamour retouching, celebrity resemblance, text, logo, watermark, UI or other people.

Character briefs then specified only the visible traits needed to distinguish the cast: approximate adult age, gender presentation where the persona already made it clear, hairstyle, expression, ordinary clothing, one restrained prop at most and the existing avatar palette. Ambiguous names remain intentionally androgynous.

## Cast mapping

| Resident | Asset | Visual direction |
|---|---|---|
| Mira | `mira.webp` | curious late-twenties woman, copper-brown curls, coral overshirt |
| Bosse.exe | `bosse.webp` | scruffy mid-thirties man, crooked deadpan grin, purple overshirt |
| Sana | `sana.webp` | grounded builder in her thirties, natural curls, mint work shirt |
| Nox | `nox.webp` | androgynous night owl, long dark hair, slate turtleneck |
| Linnea | `linnea.webp` | precise forty-year-old woman, glasses, ochre cardigan |
| Runa | `runa.webp` | calm woman in her forties, silver at the temples, rose and charcoal |
| KimchiKungen | `kim.webp` | expressive middle-aged man, moustache, burnt-orange workwear |
| Vale | `vale.webp` | androgynous contrarian, asymmetrical hair, indigo tailoring |
| Pixel | `pixel.webp` | playful androgynous designer, round glasses, cyan overshirt |
| Otto | `otto.webp` | patient older man, salt-and-pepper hair, wired headphones |
| Juno | `juno.webp` | witty young woman, sleek bob, plum second-hand jacket |
| Ibrahim | `ibrahim.webp` | thoughtful systems thinker in his forties, green knit |
| Tess | `tess.webp` | curious hobby hopper, messy bun, paint-marked denim |
| moss | `moss.webp` | quiet nonbinary adult, long curls, forest-green knit |
| Zed | `zed.webp` | skeptical man in his forties, greying beard, oxblood jacket |
| Bea | `bea.webp` | pragmatic woman in her thirties, pixie cut, blue chore jacket |
| Elio | `elio.webp` | warm stubborn optimist, loose curls, mustard overshirt |
| Farah | `farah.webp` | analytical woman in her forties, silver streak, camel knit |
| Aya | `aya.webp` | focused privacy tinkerer, blunt bob, deep-teal zip top |
| Robin | `robin.webp` | quiet androgynous consensus breaker, sandy curls, plum knit |

The final files are 512×512 WebP images. `Member.avatar.imageUrl` is optional by design: the original per-resident colour, accent and glyph remain available when an image is missing, blocked or fails to decode.
