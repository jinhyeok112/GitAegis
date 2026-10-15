"use server";

import { AuthError } from "next-auth";
import { redirect } from "next/navigation";
import { isGitHubConfigured, signIn } from "@/auth";

export async function loginWithGitHub() {
  if (!isGitHubConfigured()) redirect("/login?error=Configuration");

  try {
    await signIn("github", { redirectTo: "/" });
  } catch (error) {
    if (error instanceof AuthError) {
      redirect(`/login?error=${encodeURIComponent(error.type)}`);
    }
    // Next.js also implements successful redirects by throwing. Preserve them.
    throw error;
  }
}

