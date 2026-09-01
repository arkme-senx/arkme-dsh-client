export const UPDATE_CHECK_ENABLED_ENV = "ARKME_UPDATE_CHECK_ENABLED";
export const AUTOMATIC_UPDATE_CHECK_INTERVAL_MS = 30 * 60_000;

type UpdateCheckEnvironment = Readonly<Record<string, string | undefined>>;

export function isAutomaticUpdateCheckEnabled(
  environment: UpdateCheckEnvironment = process.env
): boolean {
  return environment[UPDATE_CHECK_ENABLED_ENV] !== "0";
}

export function withStartupUpdateCheckEnvironment(
  environment: NodeJS.ProcessEnv,
  isPackaged: boolean,
  packagedLocalTest: boolean
): NodeJS.ProcessEnv {
  return {
    ...environment,
    [UPDATE_CHECK_ENABLED_ENV]: isPackaged && !packagedLocalTest ? "1" : "0"
  };
}
