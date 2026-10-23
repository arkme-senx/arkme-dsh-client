import {createHash} from "node:crypto";
/** Shared host contract; website defaults retain existing feature-level checks. */
export function pluginHostPolicy(mas: boolean, developmentDataPath?: string): string {
  return JSON.stringify({schemaVersion:1, distribution:mas ? 'mas' : 'website',
    capabilities:{clientSelfUpdate:!mas, runtimeSelfUpdate:!mas, executableExtensionInstall:!mas},
    ...(mas ? {credentialServicePrefix:'com.senqisi.dsh-arkme.mas'} : developmentDataPath ? {credentialServicePrefix:`com.senqisi.dsh-arkme.dev.${createHash('sha256').update(developmentDataPath).digest('hex').slice(0,24)}`} : {})});
}
