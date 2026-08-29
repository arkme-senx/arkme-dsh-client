import {
  completePluginInstallBootstrap,
  preparePluginInstallBootstrap
} from "./plugin-install-bootstrap.js";
import {
  provisionArkmeWebProfile,
  type ProfilePackageManager
} from "./plugin-profile.js";
import { readPackagedTestPluginPath } from "./runtime-path.js";

export interface PackagedPluginStartupOptions {
  resourcesPath: string;
  dshHome: string;
  appVersion: string;
  dshVersion?: string;
  profileName: string;
  packageManager: ProfilePackageManager;
}

interface PackagedPluginStartupDependencies {
  readTestPluginPath?: typeof readPackagedTestPluginPath;
  prepareBootstrap?: typeof preparePluginInstallBootstrap;
  provisionProfile?: typeof provisionArkmeWebProfile;
  completeBootstrap?: typeof completePluginInstallBootstrap;
}

export async function preparePackagedPluginForLaunch(
  options: PackagedPluginStartupOptions,
  dependencies: PackagedPluginStartupDependencies = {}
): Promise<string> {
  const readTestPluginPath = dependencies.readTestPluginPath ?? readPackagedTestPluginPath;
  const prepareBootstrap = dependencies.prepareBootstrap ?? preparePluginInstallBootstrap;
  const provisionProfile = dependencies.provisionProfile ?? provisionArkmeWebProfile;
  const completeBootstrap = dependencies.completeBootstrap ?? completePluginInstallBootstrap;

  const testPluginDir = await readTestPluginPath(options.resourcesPath);
  if (testPluginDir !== undefined) {
    const provisioned = await provisionProfile({
      dshHome: options.dshHome,
      pluginDir: testPluginDir,
      appVersion: options.appVersion,
      ...(options.dshVersion === undefined ? {} : { dshVersion: options.dshVersion }),
      packageManager: options.packageManager
    });
    return provisioned.pluginDir;
  }

  const preparation = await prepareBootstrap({
    resourcesPath: options.resourcesPath,
    dshHome: options.dshHome,
    appVersion: options.appVersion,
    profileName: options.profileName
  });
  const provisioned = await provisionProfile({
    dshHome: options.dshHome,
    embeddedArtifact: preparation.artifact,
    forceEmbedded: preparation.resetRequired,
    appVersion: options.appVersion,
    ...(options.dshVersion === undefined ? {} : { dshVersion: options.dshVersion }),
    packageManager: options.packageManager
  });
  await completeBootstrap({
    dshHome: options.dshHome,
    appVersion: options.appVersion,
    profileName: options.profileName,
    artifact: preparation.artifact,
    selectedPluginVersion: provisioned.version
  });
  return provisioned.pluginDir;
}
