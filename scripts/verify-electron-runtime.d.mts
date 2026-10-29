export function assertElectronInstallation(expected: string, installed: string, runtime: { electronVersion: string; modulesAbi: string | number }): void;
export function verifyElectronRuntime(options?: { harness?: boolean }): Promise<{ electronVersion: string; modulesAbi: string }>;
