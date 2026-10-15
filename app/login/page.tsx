import { redirect } from "next/navigation";
import { auth, isGitHubConfigured } from "@/auth";
import { loginWithGitHub } from "@/app/actions/auth";
import LoginButton from "@/components/login-button";

const errorMessages: Record<string, string> = {
  AccessDenied: "GitHub 로그인 승인이 취소되었습니다. 다시 시도해 주세요.",
  OAuthCallbackError: "GitHub 인증을 완료하지 못했습니다. 다시 로그인해 주세요.",
  OAuthSignInError: "GitHub에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.",
  Configuration: "현재 GitHub 로그인을 사용할 수 없습니다. 잠시 후 다시 시도해 주세요.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  const session = await auth();
  if (session?.user) redirect("/");

  const { error } = await searchParams;
  const configured = isGitHubConfigured();
  const errorMessage = !configured
    ? errorMessages.Configuration
    : typeof error === "string"
      ? Object.hasOwn(errorMessages, error)
        ? errorMessages[error]
        : "로그인을 완료하지 못했습니다. 다시 시도해 주세요."
      : null;

  return (
    <main className="login-screen">
      <section className="login-card" aria-labelledby="login-title">
        <div className="brand">
          <span className="brand-symbol" aria-hidden="true">
            <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3Z M9 12l2 2 4-4" />
            </svg>
          </span>
          GitAegis
        </div>
        <h1 id="login-title">GitHub 계정으로 시작하기</h1>
        <p>저장소의 보안 위험을 한곳에서 확인하세요.</p>
        {errorMessage && <div className="login-error" role="alert">{errorMessage}</div>}
        <form action={loginWithGitHub}>
          <LoginButton disabled={!configured} />
        </form>
        <small>공개·비공개 저장소 목록을 불러옵니다.<br />GitHub repo 권한에는 쓰기도 포함되며, 서비스는 조회만 수행합니다.</small>
        <small>로그인은 7일간 유지됩니다.<br />공용 PC에서는 사용 후 로그아웃해 주세요.</small>
      </section>
    </main>
  );
}
