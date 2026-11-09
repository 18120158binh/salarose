import '@testing-library/jest-dom'

// React Flow requires ResizeObserver
if (typeof window !== 'undefined') {
  window.PointerEvent = window.PointerEvent || MouseEvent as typeof PointerEvent;
  window.ResizeObserver = window.ResizeObserver || class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
