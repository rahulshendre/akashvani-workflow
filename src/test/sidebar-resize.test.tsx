import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { StepSidebar } from '@/components/StepSidebar';
import { createInitialState } from '@/lib/pipeline';

const steps = createInitialState(null).steps;

function renderSidebar() {
  return render(
    <StepSidebar
      steps={steps}
      activeStepIndex={0}
      onSelectStep={() => {}}
      selectionWhileIdle
    />
  );
}

/**
 * jsdom gives every element a zero-width rect, so the left edge is 0 and
 * clientX is the resulting width.
 *
 * mouseDown must be committed in its own act() before moving: the window
 * listeners are attached by an effect that only runs once React has flushed
 * the dragging state.
 */
async function dragTo(x: number) {
  const handle = screen.getByRole('separator');
  await act(async () => { fireEvent.mouseDown(handle); });
  await act(async () => { fireEvent.mouseMove(window, { clientX: x }); });
  await act(async () => { fireEvent.mouseUp(window); });
}

beforeEach(() => localStorage.clear());

describe('resizable step list', () => {
  it('starts at the default width', async () => {
    await act(async () => { renderSidebar(); });
    const aside = screen.getByRole('separator').parentElement!;
    expect(aside.style.width).toBe('288px');
  });

  // REGRESSION: names were fixed-width with `truncate`, so every step read
  // "Copy videos into the wo…" with no way to see the rest.
  it('shows the full step name rather than cutting it off', async () => {
    await act(async () => { renderSidebar(); });
    const name = screen.getByText('Copy videos into the workspace');
    expect(name.className).not.toContain('truncate');
    // Kept as a tooltip for anyone who leaves the sidebar narrow.
    expect(name.getAttribute('title')).toBe('Copy videos into the workspace');
  });

  it('widens when the divider is dragged right', async () => {
    await act(async () => { renderSidebar(); });
    const aside = screen.getByRole('separator').parentElement!;
    await dragTo(460);
    expect(aside.style.width).toBe('460px');
  });

  it('clamps to a usable range instead of collapsing or taking over', async () => {
    await act(async () => { renderSidebar(); });
    const aside = screen.getByRole('separator').parentElement!;

    await dragTo(20);      // far too narrow
    expect(aside.style.width).toBe('220px');

    await dragTo(4000);    // far too wide
    expect(aside.style.width).toBe('560px');
  });

  it('remembers the width for next launch', async () => {
    const first = renderSidebar();
    await dragTo(400);
    expect(localStorage.getItem('akashvani-sidebar-width')).toBe('400');

    first.unmount();
    await act(async () => { renderSidebar(); });
    expect(screen.getByRole('separator').parentElement!.style.width).toBe('400px');
  });

  it('resets on double-click', async () => {
    await act(async () => { renderSidebar(); });
    const aside = screen.getByRole('separator').parentElement!;
    await dragTo(500);
    expect(aside.style.width).toBe('500px');

    await act(async () => { fireEvent.doubleClick(screen.getByRole('separator')); });
    expect(aside.style.width).toBe('288px');
  });

  it('can be resized from the keyboard', async () => {
    await act(async () => { renderSidebar(); });
    const handle = screen.getByRole('separator');
    const aside = handle.parentElement!;

    await act(async () => { fireEvent.keyDown(handle, { key: 'ArrowRight' }); });
    expect(aside.style.width).toBe('304px');

    await act(async () => { fireEvent.keyDown(handle, { key: 'ArrowLeft' }); });
    expect(aside.style.width).toBe('288px');
  });
});
