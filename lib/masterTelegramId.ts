// Telegram-id мастера, которому уходят уведомления. Раньше в четырёх
// эндпоинтах стоял общий запасной id Ани: деплой другого мастера без
// переменной тихо слал бы его уведомления ей. Теперь запасное значение
// действует только для профиля Ани (старый деплой), для остальных
// профилей без корректного MASTER_TELEGRAM_ID id нет, и это пишется в лог.
import { getMasterProfile } from './masters';

const LEGACY_ANYA_TELEGRAM_ID = 457343487;

export function resolveMasterTelegramId(raw: string | undefined, profileId: string): number | null {
  const n = Number((raw ?? '').trim());
  if (Number.isInteger(n) && n > 0) return n;
  return profileId === 'anya' ? LEGACY_ANYA_TELEGRAM_ID : null;
}

// 0 = id не задан: Telegram отклонит отправку (ошибка в логе, sendTelegram*
// вернёт false), но уведомления не уйдут чужому мастеру.
export function getMasterTelegramId(): number {
  const profile = getMasterProfile();
  const id = resolveMasterTelegramId(process.env.MASTER_TELEGRAM_ID, profile.id);
  if (id === null) {
    console.error(`MASTER_TELEGRAM_ID не задан или некорректен для профиля "${profile.id}" — уведомления мастеру не будут отправлены`);
    return 0;
  }
  return id;
}
