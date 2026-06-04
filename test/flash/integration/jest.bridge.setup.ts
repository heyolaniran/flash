// Minimal setup for Bridge integration tests (no global Ibex/GraphQL fixtures).
jest.mock("yargs", () => {
  const yargsMock = {
    option: jest.fn().mockReturnThis(),
    argv: {
      configPath: ["./dev/config/base-config.yaml"],
    },
  }
  return jest.fn(() => yargsMock)
})

jest.setTimeout(Number(process.env.JEST_TIMEOUT) || 30000)
