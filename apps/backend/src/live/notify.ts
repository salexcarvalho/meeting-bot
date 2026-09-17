import { getMeeting } from "../db";
import { toMeetingSummary } from "../meetings/summary";
import { hub } from "./hub";

// Publica o estado atual da reunião para a agenda e para quem acompanha a reunião.
export async function notifyMeeting(meetingId: string): Promise<void> {
  try {
    const meeting = await getMeeting(meetingId);
    if (meeting) hub.publishBoth(meetingId, { type: "meeting", meeting: toMeetingSummary(meeting) });
  } catch (err) {
    console.error(`[live] falha ao publicar reunião ${meetingId}:`, err);
  }
}
