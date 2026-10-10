const developerIDApplicationPrefix = 'Developer ID Application: ';

export function electronBuilderCSCName(identity) {
  const name = identity?.trim();
  if (!name?.startsWith(developerIDApplicationPrefix) || name.length === developerIDApplicationPrefix.length) {
    throw new Error('CSC_NAME must be a complete Developer ID Application identity');
  }
  return name.slice(developerIDApplicationPrefix.length);
}
