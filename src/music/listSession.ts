/** Tracks who opened a paginated /list message (for button auth). */
export interface ListMessageSession {
  userId: string;
  guildId: string;
  page: number;
}

const sessions = new Map<string, ListMessageSession>();

export function registerListMessage(
  messageId: string,
  session: ListMessageSession,
): void {
  sessions.set(messageId, session);
}

export function getListMessageSession(messageId: string): ListMessageSession | undefined {
  return sessions.get(messageId);
}

export function updateListMessagePage(messageId: string, page: number): void {
  const session = sessions.get(messageId);
  if (session) {
    session.page = page;
  }
}

export function clearListMessageSession(messageId: string): void {
  sessions.delete(messageId);
}
