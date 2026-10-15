"use client";

import { useFormStatus } from "react-dom";

export default function LoginButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();

  return (
    <button type="submit" className="button primary" disabled={disabled || pending}>
      {pending ? "GitHub로 이동 중…" : "GitHub로 계속하기"}
    </button>
  );
}
