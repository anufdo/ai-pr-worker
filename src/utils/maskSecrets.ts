export function maskSecrets(value: string, secrets: readonly string[]): string {
  return secrets.reduce((masked, secret) => {
    if (!secret) return masked;
    return masked.split(secret).join("***");
  }, value);
}
