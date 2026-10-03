type SignalHost = Pick<NodeJS.Process, "on" | "off">;

/** Service-manager termination checkpoints execution before releasing the process. */
export function installShutdownSignals(
  shutdown: () => Promise<void>,
  host: SignalHost = process,
  finished: (code: number) => void = (code) => process.exit(code),
): () => void {
  let closing: Promise<void> | undefined;
  const stop = () => {
    if (closing) return;
    closing = shutdown();
    void closing.then(
      () => finished(0),
      (error) => {
        console.error("Failed to checkpoint Batty during shutdown", error);
        finished(1);
      },
    );
  };
  host.on("SIGTERM", stop);
  host.on("SIGINT", stop);
  return () => {
    host.off("SIGTERM", stop);
    host.off("SIGINT", stop);
  };
}
