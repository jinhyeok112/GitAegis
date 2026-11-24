import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { RowDataPacket } from "mysql2";
import { COMMIT_CHECK_INTERVAL_SECONDS, nextScheduledScan } from "@/lib/scan-policy";
import { getDatabase, isDatabaseConfigured } from "@/lib/server/db";
import { ServiceError } from "@/lib/server/errors";
import { runNextAutomaticScan } from "@/lib/server/manual-scan";
import { GitHubPollError, latestRepositoryCommit } from "@/lib/server/github";

export async function pollRepositoryCommit() {
  const connection = await getDatabase().getConnection();
  const lock = `gitaegis:commit-poll:${createHash("sha256").update(process.env.MYSQL_DATABASE || "").digest("hex").slice(0, 24)}`;
  let acquired = false;
  try {
    const [locks] = await connection.execute<RowDataPacket[]>("SELECT GET_LOCK(?, 0) AS acquired", [lock]);
    if (Number(locks[0].acquired) !== 1) return;
    acquired = true;
    await connection.execute(`INSERT IGNORE INTO repository_commit_checks (repository_id, next_check_at)
      SELECT id, UTC_TIMESTAMP(3) FROM repositories WHERE connected = TRUE AND scan_on_push = TRUE`);
    const [rows] = await connection.execute<RowDataPacket[]>(`SELECT c.*, r.user_id, r.github_repository_id
      FROM repository_commit_checks c JOIN repositories r ON r.id = c.repository_id
      WHERE r.connected = TRUE AND r.scan_on_push = TRUE AND c.next_check_at <= UTC_TIMESTAMP(3)
      ORDER BY c.next_check_at, c.repository_id LIMIT 1`);
    const repo = rows[0];
    if (!repo) return;
    // Persist a lease before making API calls, including if this process stops.
    await connection.execute("UPDATE repository_commit_checks SET next_check_at = TIMESTAMPADD(SECOND, ?, UTC_TIMESTAMP(3)) WHERE repository_id = ?", [COMMIT_CHECK_INTERVAL_SECONDS, repo.repository_id]);
    try {
      const current = await latestRepositoryCommit(String(repo.user_id), String(repo.github_repository_id), { branch: repo.branch_name, etag: repo.etag });
      await connection.beginTransaction();
      const [enabled] = await connection.execute<RowDataPacket[]>("SELECT connected, scan_on_push FROM repositories WHERE id = ? FOR UPDATE", [repo.repository_id]);
      if (enabled[0]?.connected && enabled[0]?.scan_on_push) {
        if (current.sha && repo.commit_sha && current.sha !== repo.commit_sha) {
          await connection.execute("INSERT INTO scans (id, repository_id, trigger_type, commit_sha) VALUES (?, ?, 'push', ?)", [randomUUID(), repo.repository_id, current.sha]);
        }
        await connection.execute(`UPDATE repository_commit_checks SET commit_sha = ?, branch_name = ?, etag = ?,
          checked_at = UTC_TIMESTAMP(3), error_message = NULL, next_check_at = TIMESTAMPADD(SECOND, ?, UTC_TIMESTAMP(3))
          WHERE repository_id = ?`, [current.sha ?? repo.commit_sha, current.branch, current.etag ?? repo.etag, current.pollSeconds, repo.repository_id]);
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      const message = error instanceof ServiceError ? error.message : "커밋 변경을 확인하지 못했습니다. 서버 연결 상태를 확인해 주세요.";
      await connection.execute(`UPDATE repository_commit_checks SET error_message = ?, next_check_at = TIMESTAMPADD(SECOND, ?, UTC_TIMESTAMP(3))
        WHERE repository_id = ?`, [message, error instanceof GitHubPollError ? error.retryAfterSeconds : COMMIT_CHECK_INTERVAL_SECONDS, repo.repository_id]);
      if (error instanceof GitHubPollError) {
        // The OAuth API budget is shared by every repository of the same user.
        await connection.execute(`UPDATE repository_commit_checks c JOIN repositories r ON r.id = c.repository_id
          SET c.next_check_at = GREATEST(c.next_check_at, TIMESTAMPADD(SECOND, ?, UTC_TIMESTAMP(3)))
          WHERE r.user_id = ?`, [error.retryAfterSeconds, repo.user_id]);
      }
    }
  } finally {
    if (acquired) await connection.execute("SELECT RELEASE_LOCK(?)", [lock]).catch(() => {});
    connection.release();
  }
}

export async function enqueueScheduledScan() {
  const connection = await getDatabase().getConnection();
  try {
    await connection.beginTransaction();
    // Store the next slot and enqueue the current slot together. This also
    // initializes policies saved before automatic scanning was available.
    const [rows] = await connection.execute<RowDataPacket[]>(`SELECT id, next_scheduled_at, scheduled_scan_frequency,
      scheduled_scan_weekday, scheduled_scan_time FROM repositories
      WHERE connected = TRUE AND scheduled_scan_enabled = TRUE
        AND (next_scheduled_at IS NULL OR next_scheduled_at <= UTC_TIMESTAMP(3))
      ORDER BY next_scheduled_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`);
    const repo = rows[0];
    if (repo) {
      const next = nextScheduledScan(new Date(), {
        frequency: repo.scheduled_scan_frequency,
        weekday: Number(repo.scheduled_scan_weekday),
        time: String(repo.scheduled_scan_time).slice(0, 5),
      });
      if (repo.next_scheduled_at !== null) {
        // If the server was offline for several slots, run once on recovery.
        await connection.execute(`INSERT INTO scans (id, repository_id, trigger_type)
          SELECT ?, ?, 'schedule' FROM DUAL WHERE NOT EXISTS (
            SELECT 1 FROM scans WHERE repository_id = ? AND trigger_type = 'schedule' AND status IN ('queued', 'running')
          )`, [randomUUID(), repo.id, repo.id]);
      }
      await connection.execute("UPDATE repositories SET next_scheduled_at = ? WHERE id = ?", [next, repo.id]);
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

const workerGlobal = globalThis as typeof globalThis & { gitAegisAutomaticScanWorker?: boolean };

export function startAutomaticScanWorker() {
  if (workerGlobal.gitAegisAutomaticScanWorker || !isDatabaseConfigured()) return;
  workerGlobal.gitAegisAutomaticScanWorker = true;

  async function poll() {
    try { await pollRepositoryCommit(); }
    catch { console.error("Commit polling unavailable. Check database readiness."); }
    finally { setTimeout(() => void poll(), 1000).unref(); }
  }

  async function tick() {
    try {
      await enqueueScheduledScan();
      await runNextAutomaticScan();
    } catch (error) {
      // Contention is expected. Scan failures are recorded in scan history.
      if (!(error instanceof ServiceError)) console.error("Automatic scan worker unavailable. Check database readiness.");
    } finally {
      setTimeout(() => void tick(), 5000).unref();
    }
  }

  setTimeout(() => void tick(), 5000).unref();
  setTimeout(() => void poll(), 1000).unref();
}
