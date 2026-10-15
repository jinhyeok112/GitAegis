import { requireDatabaseUser } from "@/lib/server/request-auth";
import { loadDashboard } from "@/lib/server/dashboard-data";
import { errorResponse } from "@/lib/server/errors";

export async function GET() {
  try {
    const { userId } = await requireDatabaseUser();
    return Response.json(await loadDashboard(userId), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return errorResponse(error); }
}
