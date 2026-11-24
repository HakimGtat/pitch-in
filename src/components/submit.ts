"use client";

import { startTransition, type FormEvent } from "react";

/**
 * Submits a form to a useActionState action without React's automatic form
 * reset. The reset would clear controlled radio buttons (the estimate, the
 * kind) every time the brief checker sends the form back.
 */
export function submitWithoutReset(action: (formData: FormData) => void) {
  return (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // Keep the button that was pressed, e.g. "Post anyway" (name="ack").
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const formData = new FormData(event.currentTarget, submitter);
    startTransition(() => action(formData));
  };
}
