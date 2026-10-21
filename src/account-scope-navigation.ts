/** Account bridge acknowledgements must not wait for renderer navigation. */
export async function revealAfterAccountAcknowledgement(
  reveal: () => Promise<void>,
  onError: (error: unknown) => void
): Promise<void> {
  setTimeout(() => { void Promise.resolve().then(reveal).catch(onError); }, 0);
}
