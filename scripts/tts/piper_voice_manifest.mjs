export const PIPER_VOICE_REVISION = "e21c7de8d4eab79b902f0d61e662b3f21664b8d2";

const baseUrl = `https://huggingface.co/rhasspy/piper-voices/resolve/${PIPER_VOICE_REVISION}`;

export const PIPER_VOICE_FILES = Object.freeze([
  {
    voice: "lisa",
    relativePath: "voices/lisa/sv_SE-lisa-medium.onnx",
    url: `${baseUrl}/sv/sv_SE/lisa/medium/sv_SE-lisa-medium.onnx?download=true`,
    bytes: 63_511_038,
    sha256: "94cae912b31d6e9140d3f5160f1815951588600c7a9e43d539ba1e81a110d131",
  },
  {
    voice: "lisa",
    relativePath: "voices/lisa/sv_SE-lisa-medium.onnx.json",
    url: `${baseUrl}/sv/sv_SE/lisa/medium/sv_SE-lisa-medium.onnx.json?download=true`,
    bytes: 7_239,
    sha256: "51e48b65d7427aee9e8e736b370ff4fe6e3e45e47a56e5d8819647b7076ffb0a",
  },
  {
    voice: "lisa",
    relativePath: "voices/lisa/MODEL_CARD",
    url: `${baseUrl}/sv/sv_SE/lisa/medium/MODEL_CARD?download=true`,
    bytes: 198,
    sha256: "952c05227c175d48aafe40eb73935d8cf6b7a214ad4f9772b4180c084e5094c3",
  },
  {
    voice: "nst",
    relativePath: "voices/nst/sv_SE-nst-medium.onnx",
    url: `${baseUrl}/sv/sv_SE/nst/medium/sv_SE-nst-medium.onnx?download=true`,
    bytes: 63_104_526,
    sha256: "df011f56825a59dd1efc080c38a65a1ef70407e60f63050e9246f43a3d7e471e",
  },
  {
    voice: "nst",
    relativePath: "voices/nst/sv_SE-nst-medium.onnx.json",
    url: `${baseUrl}/sv/sv_SE/nst/medium/sv_SE-nst-medium.onnx.json?download=true`,
    bytes: 4_157,
    sha256: "d45dd74cbb4eca58694bf04a97e243044092476f28a55ae26424f0653086980a",
  },
  {
    voice: "nst",
    relativePath: "voices/nst/MODEL_CARD",
    url: `${baseUrl}/sv/sv_SE/nst/medium/MODEL_CARD?download=true`,
    bytes: 306,
    sha256: "c85d3e26e47d93e9d9b8572d3c89537c3f8ff212595cb9a3fbd2e07c19432317",
  },
]);
