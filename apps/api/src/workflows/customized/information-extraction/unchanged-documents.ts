type Document = {
  assetId: string;
  assetVersion: number;
  storageKey: string;
  sizeBytes: number;
  name: string;
};
/** Reuse only document-local extraction. Fusion and semantic review must read all current inputs. */
export function unchangedDocumentIds(
  previous: readonly Document[],
  current: readonly Document[],
): string[] {
  return current
    .filter((doc) =>
      previous.some(
        (old) =>
          old.assetId === doc.assetId &&
          old.assetVersion === doc.assetVersion &&
          old.storageKey === doc.storageKey &&
          old.sizeBytes === doc.sizeBytes &&
          old.name === doc.name,
      ),
    )
    .map((doc) => doc.assetId);
}
