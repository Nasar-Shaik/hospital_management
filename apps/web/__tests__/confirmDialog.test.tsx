/**
 * W-3 — CONFIRMATIONS BELONG TO THE APPLICATION, NOT TO THE BROWSER.
 *
 * ── THE DEFECT THIS CLOSES ──────────────────────────────────────────────────
 * Twelve places asked a question with `window.confirm` or `window.prompt`. Manual testing noticed
 * it first as a look — "we are using browser default confirmation box" on the lab's Mark complete —
 * but the styling is the least of it. A native dialog:
 *
 *   • cannot say WHICH patient it is about, so "Mark complete" was a yes/no about nothing;
 *   • validates nothing, so a two-character cancellation reason came back from the server as a
 *     422 the user could not connect to anything they had done;
 *   • turns `toPaise("12o0")` into ZERO, silently approving an insurance claim for nothing;
 *   • CAN BE SUPPRESSED. Chrome offers "prevent this page from creating additional dialogues"
 *     after the second one, and it is blanket-suppressed inside a cross-origin frame. A technician
 *     who ticks that box gets `prompt() === null`, which our code read as "cancelled" — so Cancel
 *     order and Mark complete became buttons that did nothing, forever, with no error anywhere.
 *
 * The admin console had already reached the same conclusion and built its own `Confirm`; this is
 * that lesson applied to the clinical app, from one shared component.
 *
 * ── WHAT THE LAST BLOCK IS FOR ──────────────────────────────────────────────
 * Behaviour tests prove the replacement works. They cannot prove the thing it replaced is GONE —
 * so the suite also scans every page source. That assertion is the one that will fail when someone
 * reaches for `window.confirm` again next year.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ConfirmDialog } from "../components/ui";

afterEach(cleanup);

describe("a confirmation without a reason (what `window.confirm` used to do)", () => {
  it("shows the consequence and confirms with an empty reason", () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog title="Revoke the key?" onConfirm={onConfirm} onCancel={vi.fn()}>
        <p>Any integration using it stops working immediately.</p>
      </ConfirmDialog>,
    );

    expect(screen.getByText(/stops working immediately/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
    expect(onConfirm).toHaveBeenCalledWith("");
  });

  it("cancelling calls back and never confirms", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<ConfirmDialog title="Revoke the key?" onConfirm={onConfirm} onCancel={onCancel} />);

    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(onCancel).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("Escape cancels — the native dialog's one genuinely good habit, kept", () => {
    const onCancel = vi.fn();
    render(<ConfirmDialog title="Revoke the key?" onConfirm={vi.fn()} onCancel={onCancel} />);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalled();
  });

  it("is announced as a dialog, which `window.confirm` never was to our own a11y tree", () => {
    render(<ConfirmDialog title="Revoke the key?" onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});

describe("a confirmation that collects a reason (what `window.prompt` used to do)", () => {
  it("hands the typed reason, trimmed, to the caller", () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        title="Cancel order"
        reason={{ label: "Why is this order being cancelled?", minLength: 3 }}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "  Sample haemolysed  " } });
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
    expect(onConfirm).toHaveBeenCalledWith("Sample haemolysed");
  });

  it("holds the button shut below the server's own minimum", () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        title="Cancel order"
        // 3 is `cancelOrderSchema`'s min. A prompt cheerfully accepted "x" and let the server
        // refuse it, which is how a validation error arrives with nothing to connect it to.
        reason={{ label: "Why?", minLength: 3 }}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );

    const confirm = screen.getByRole("button", { name: /confirm/i }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "x" } });
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "haemolysed" } });
    expect(confirm.disabled).toBe(false);
  });

  it("whitespace does not satisfy a minimum", () => {
    render(
      <ConfirmDialog
        title="Cancel order"
        reason={{ label: "Why?", minLength: 3 }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "     " } });
    expect((screen.getByRole("button", { name: /confirm/i }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("an optional reason confirms while empty", () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        title="Mark complete"
        reason={{ label: "Result note" }}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
    expect(onConfirm).toHaveBeenCalledWith("");
  });

  it("a default value is offered, as the prompt's second argument used to be", () => {
    render(
      <ConfirmDialog
        title="Mark complete"
        reason={{ label: "Result note", defaultValue: "See uploaded report" }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("See uploaded report");
  });
});

describe("the money check `window.prompt` could not do", () => {
  const amount = {
    label: "Amount the payer approved (₹)",
    multiline: false as const,
    minLength: 1,
    validate: (raw: string) => {
      const value = Number(raw);
      if (!Number.isFinite(value)) return "Enter a number — for example 12500 or 12500.50.";
      if (value < 0) return "An amount cannot be negative.";
      return null;
    },
  };

  it("refuses a figure that `toPaise` would silently turn into zero", () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        title="Record the decision"
        reason={amount}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "12o0" } });
    expect(screen.getByText(/Enter a number/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("refuses a negative amount and accepts a real one", () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        title="Record the decision"
        reason={amount}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "-500" } });
    expect(screen.getByText(/cannot be negative/i)).toBeTruthy();

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "12500.50" } });
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
    expect(onConfirm).toHaveBeenCalledWith("12500.50");
  });
});

describe("a dialog with a request in flight cannot be double-submitted or escaped", () => {
  it("holds both buttons", () => {
    const onConfirm = vi.fn();
    render(<ConfirmDialog title="Cancel order" busy onConfirm={onConfirm} onCancel={vi.fn()} />);

    expect((screen.getByRole("button", { name: /confirm/i }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole("button", { name: /^cancel$/i }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("ignores Escape and the ✕, so nobody is left wondering whether it happened", () => {
    const onCancel = vi.fn();
    render(<ConfirmDialog title="Cancel order" busy onConfirm={vi.fn()} onCancel={onCancel} />);

    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(onCancel).not.toHaveBeenCalled();
  });
});

/**
 * ── THE AUDIT ───────────────────────────────────────────────────────────────
 * Every `.ts`/`.tsx` under `app/` and `components/`. Comments mentioning `window.prompt` in prose
 * do not match, because the pattern requires the opening parenthesis of a real call.
 */
describe("no page asks the browser to ask the question", () => {
  function sources(dir: string, found: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        if (entry === "node_modules" || entry.startsWith(".")) continue;
        sources(path, found);
      } else if (/\.tsx?$/.test(entry)) {
        found.push(path);
      }
    }
    return found;
  }

  const root = join(__dirname, "..");
  const files = [...sources(join(root, "app")), ...sources(join(root, "components"))];

  it("finds sources to check at all (a scan over nothing proves nothing)", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  for (const kind of ["confirm", "prompt", "alert"] as const) {
    it(`no window.${kind}() survives anywhere in the app`, () => {
      const offenders = files.filter((f) =>
        new RegExp(`window\\.${kind}\\s*\\(`).test(readFileSync(f, "utf8")),
      );
      expect(offenders.map((f) => f.slice(root.length + 1))).toEqual([]);
    });
  }
});
