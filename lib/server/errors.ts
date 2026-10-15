export class ServiceError extends Error {
  constructor(public code: string, message: string, public status = 503) {
    super(message);
  }
}

export function errorResponse(error: unknown) {
  if (error instanceof ServiceError) {
    return Response.json({ code: error.code, error: error.message }, { status: error.status, headers: { "Cache-Control": "no-store" } });
  }
  // SQL errors can contain query text and credentials. Never return them to clients.
  console.error("Data operation failed:", error && typeof error === "object" && "code" in error ? String(error.code) : "UNEXPECTED_ERROR");
  return Response.json({ code: "DATABASE_UNAVAILABLE", error: "데이터를 불러오거나 저장하지 못했습니다. DB 연결 상태를 확인한 뒤 다시 시도해 주세요." }, { status: 503, headers: { "Cache-Control": "no-store" } });
}
