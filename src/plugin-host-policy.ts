/** Shared host contract; website defaults retain existing feature-level checks. */
export function pluginHostPolicy(mas: boolean): string {
  return JSON.stringify({schemaVersion:1, distribution:mas ? 'mas' : 'website',
    capabilities:{clientSelfUpdate:!mas, runtimeSelfUpdate:!mas, executableExtensionInstall:!mas},
    ...(mas ? {credentialServicePrefix:'com.senqisi.dsh-arkme.mas'} : {})});
}
