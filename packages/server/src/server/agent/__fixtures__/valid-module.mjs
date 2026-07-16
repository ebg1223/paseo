export default {
  definition: {
    id: "valid",
    label: "Valid",
    description: "A valid provider module fixture.",
    defaultModeId: "default",
    modes: [
      {
        id: "default",
        label: "Default",
        icon: "sparkles",
        colorTier: "safe",
      },
    ],
  },
  createClient() {
    return {};
  },
};
