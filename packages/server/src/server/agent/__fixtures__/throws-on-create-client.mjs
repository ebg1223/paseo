export default {
  definition: {
    id: "throws-on-create-client",
    label: "Throws on createClient",
    description: "A provider module fixture whose factory throws.",
    defaultModeId: null,
    modes: [],
  },
  createClient() {
    throw new Error("fixture createClient failure");
  },
};
