export default {
  definition: {
    id: "sdk-major-mismatch",
    label: "SDK mismatch",
    description: "A provider module fixture with an incompatible SDK version.",
    defaultModeId: null,
    modes: [],
  },
  sdkVersion: "99.0.0",
  createClient() {
    return {};
  },
};
