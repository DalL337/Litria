import {
  Popover,
  PopoverAnchor,
  PopoverTrigger,
  PopoverContent,
} from '@/components/ui/popover';

/**
 * StatusBarPopover — the shadcn Popover chrome shared by the status bar's
 * three popovers (node search, zoom slider, dirty files), extracted so the
 * protected StatusBar.jsx (ADR-008) no longer imports components/ui — this
 * file retires the TEMP_ALLOWED_IMPORTS escape hatch in
 * protected-zone-guard.mjs. Rendering only: open state, mutual-exclusion
 * rules, and popover content stay with StatusBar.
 *
 * `anchor` renders a PopoverAnchor (the button keeps its own press handlers,
 * e.g. the search long-press); `trigger` renders a PopoverTrigger (Radix owns
 * the click-toggle). Pass exactly one.
 */
function StatusBarPopover({ open, onOpenChange, trigger = null, anchor = null, className, align = 'center', children }) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      {anchor
        ? <PopoverAnchor asChild>{anchor}</PopoverAnchor>
        : <PopoverTrigger asChild>{trigger}</PopoverTrigger>}
      <PopoverContent
        className={className}
        side="top"
        align={align}
        sideOffset={8}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}

export default StatusBarPopover;
