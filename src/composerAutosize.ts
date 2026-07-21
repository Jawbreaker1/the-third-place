export type ComposerOverflow = "hidden" | "auto";

export const composerAutosizeLayout = (
  scrollHeight: number,
  maxHeight: number,
): { height: number; overflowY: ComposerOverflow } => {
  const contentHeight = Number.isFinite(scrollHeight) ? Math.max(0, scrollHeight) : 0;
  const bounded = Number.isFinite(maxHeight) && maxHeight > 0;
  const height = bounded ? Math.min(contentHeight, maxHeight) : contentHeight;
  return {
    height,
    overflowY: bounded && contentHeight > maxHeight ? "auto" : "hidden",
  };
};

export const autosizeComposerTextarea = (input: HTMLTextAreaElement | null): void => {
  if (!input) return;

  // Reset before measuring so deleting lines can shrink the composer again.
  input.style.height = "auto";
  input.style.overflowY = "hidden";

  const view = input.ownerDocument.defaultView;
  const maxHeight = Number.parseFloat(view?.getComputedStyle(input).maxHeight ?? "");
  const layout = composerAutosizeLayout(input.scrollHeight, maxHeight);
  if (layout.height > 0) input.style.height = `${Math.ceil(layout.height)}px`;
  else input.style.removeProperty("height");
  input.style.overflowY = layout.overflowY;
};
