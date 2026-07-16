export default {
  definition: {
    id: "null-create-client",
    label: "Null createClient",
    description: "A provider module fixture whose factory returns null.",
    defaultModeId: null,
    modes: [],
  },
  createClient() {
    return null;
  },
};
