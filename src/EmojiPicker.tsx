import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import {
  PUBLIC_REACTION_LABELS,
  type PublicReactionEmoji,
} from "../shared/reactions";
import { filterPublicReactionEmojis } from "./emoji";

type EmojiPickerProps = {
  anchor: HTMLElement | null;
  label: string;
  onClose: (restoreFocus?: boolean) => void;
  onSelect: (emoji: PublicReactionEmoji) => void;
};

const VIEWPORT_GUTTER = 8;
const PICKER_GAP = 7;

export const EmojiPicker = ({ anchor, label, onClose, onSelect }: EmojiPickerProps) => {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState("");
  const [position, setPosition] = useState<CSSProperties>({ left: VIEWPORT_GUTTER, top: VIEWPORT_GUTTER });
  const choices = useMemo(() => filterPublicReactionEmojis(query), [query]);

  const updatePosition = useCallback(() => {
    if (!anchor) return;
    const anchorRect = anchor.getBoundingClientRect();
    const pickerRect = rootRef.current?.getBoundingClientRect();
    const width = pickerRect?.width ?? Math.min(314, window.innerWidth - VIEWPORT_GUTTER * 2);
    const height = pickerRect?.height ?? Math.min(362, window.innerHeight - VIEWPORT_GUTTER * 2);
    const roomAbove = anchorRect.top - VIEWPORT_GUTTER;
    const roomBelow = window.innerHeight - anchorRect.bottom - VIEWPORT_GUTTER;
    const placeAbove = roomAbove >= height || roomAbove > roomBelow;
    const top = placeAbove
      ? Math.max(VIEWPORT_GUTTER, anchorRect.top - height - PICKER_GAP)
      : Math.min(window.innerHeight - height - VIEWPORT_GUTTER, anchorRect.bottom + PICKER_GAP);
    const left = Math.min(
      Math.max(VIEWPORT_GUTTER, anchorRect.right - width),
      window.innerWidth - width - VIEWPORT_GUTTER,
    );
    setPosition({ left, top });
  }, [anchor]);

  useLayoutEffect(() => {
    updatePosition();
    const frame = requestAnimationFrame(updatePosition);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [choices.length, updatePosition]);

  useEffect(() => {
    searchRef.current?.focus({ preventScroll: true });
    const dismissOutside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || rootRef.current?.contains(target) || anchor?.contains(target)) return;
      onClose(false);
    };
    document.addEventListener("pointerdown", dismissOutside);
    return () => document.removeEventListener("pointerdown", dismissOutside);
  }, [anchor, onClose]);

  const handleGridKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!(event.target instanceof HTMLButtonElement) || !event.target.dataset.emoji) return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-emoji]")];
    const index = buttons.indexOf(event.target);
    if (index < 0) return;
    let next = index;
    if (event.key === "ArrowRight") next = Math.min(buttons.length - 1, index + 1);
    else if (event.key === "ArrowLeft") next = Math.max(0, index - 1);
    else if (event.key === "ArrowDown") next = Math.min(buttons.length - 1, index + 7);
    else if (event.key === "ArrowUp") next = Math.max(0, index - 7);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = buttons.length - 1;
    else return;
    event.preventDefault();
    buttons[next]?.focus();
  };

  return createPortal(
    <div
      aria-label={label}
      aria-modal="false"
      className="emoji-picker-popover"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose(true);
        }
      }}
      ref={rootRef}
      role="dialog"
      style={position}
    >
      <div className="emoji-picker-head">
        <strong>{label}</strong>
        <button type="button" onClick={() => onClose(true)} aria-label="Close emoji picker">×</button>
      </div>
      <label className="emoji-picker-search">
        <span className="visually-hidden">Search emoji</span>
        <input
          ref={searchRef}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search emoji"
          autoComplete="off"
        />
      </label>
      <div className="emoji-picker-grid" role="group" aria-label="Available emoji" onKeyDown={handleGridKeyDown}>
        {choices.map((emoji) => (
          <button
            aria-label={PUBLIC_REACTION_LABELS[emoji]}
            data-emoji={emoji}
            key={emoji}
            onClick={() => onSelect(emoji)}
            title={PUBLIC_REACTION_LABELS[emoji]}
            type="button"
          >
            <span aria-hidden="true">{emoji}</span>
          </button>
        ))}
      </div>
      {choices.length === 0 && <p className="emoji-picker-empty">No matching emoji</p>}
    </div>,
    document.body,
  );
};
