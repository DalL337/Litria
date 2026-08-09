// useKeyboardModifiers.js
// Tracks Shift, Ctrl/Cmd, and Alt key states globally.
// Uses platform-aware detection via modifierKeys utility —
// on macOS, `ctrl` reflects Cmd (metaKey), not Ctrl.

import { useState, useEffect, useCallback } from 'react';
import { primaryModifierFromFlags } from '../platform/modifierKeys';

function useKeyboardModifiers() {
  const [modifiers, setModifiers] = useState({
    shift: false,
    ctrl: false,
    alt: false
  });

  // Update modifier state from any keyboard event.
  // `ctrl` is the platform's primary modifier (Cmd on macOS, Ctrl elsewhere).
  const updateModifiers = useCallback((e) => {
    setModifiers({
      shift: e.shiftKey,
      ctrl: primaryModifierFromFlags(e.ctrlKey, e.metaKey),
      alt: e.altKey
    });
  }, []);

  // Clear all modifiers (safety reset)
  const clearModifiers = useCallback(() => {
    setModifiers({
      shift: false,
      ctrl: false,
      alt: false
    });
  }, []);

  useEffect(() => {
    // Track keydown and keyup for modifier changes
    const handleKeyDown = (e) => updateModifiers(e);
    const handleKeyUp = (e) => updateModifiers(e);
    
    // Also track when window loses focus (reset modifiers)
    // This prevents "stuck" keys if user tabs away while holding
    const handleBlur = () => clearModifiers();

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);

    // Cleanup on unmount
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
    };
  }, [updateModifiers, clearModifiers]);

  return {
    // Individual modifier states
    shift: modifiers.shift,
    ctrl: modifiers.ctrl,
    alt: modifiers.alt,
    
    // Combo checks (handy for common patterns)
    ctrlShift: modifiers.ctrl && modifiers.shift,
    ctrlAlt: modifiers.ctrl && modifiers.alt,
    shiftAlt: modifiers.shift && modifiers.alt,
    
    // Check if ANY modifier is held
    anyModifier: modifiers.shift || modifiers.ctrl || modifiers.alt,
    
    // Check if NO modifiers are held (plain click)
    noModifiers: !modifiers.shift && !modifiers.ctrl && !modifiers.alt,
    
    // Manual clear if needed
    clearModifiers
  };
}

export default useKeyboardModifiers;