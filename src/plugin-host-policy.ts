import {createHash} from "node:crypto";
/** Shared host contract; website defaults retain existing feature-level checks. */
export function pluginHostPolicy(mas: boolean, developmentDataPath?: string): string {
  return JSON.stringify({schemaVersion:1, distribution:mas ? 'mas' : 'website',
    capabilities:{clientSelfUpdate:!mas, runtimeSelfUpdate:!mas, executableExtensionInstall:!mas},
    ...(mas ? {credentialServicePrefix:'com.senqisi.dsh-arkme.mas'} : developmentDataPath ? {credentialServicePrefix:`com.senqisi.dsh-arkme.dev.${createHash('sha256').update(developmentDataPath).digest('hex').slice(0,24)}`} : {})});
}

export function pluginHostEnvironment(mas: boolean, developmentDataPath?: string): Record<string, string> {
  return {
    ARKME_HOST_POLICY: pluginHostPolicy(mas, developmentDataPath),
    // Only source development uses an unprepared upstream dependency graph.
    ...(!mas && developmentDataPath ? { ARKME_DEVELOPMENT_HOST: "1" } : {}),
    // MAS native code must load from the signed bundle, not a materialized temp copy.
    ...(mas ? { NARB_DISABLE_NATIVE_CACHE: "1" } : {})
  };
}
