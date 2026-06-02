import { supabase } from "./supabase";
import {
  BANNED_USERNAME_WORDS,
} from "../data/bannedUsernames";

export type Profile = {
  id: string;
  username: string | null;
  xp: number;
  level: number;
  gold: number;
  created_at: string;
  updated_at: string;
  username_changed_at?: string | null;
  username_change_count?: number | null;
};

const USERNAME_REGEX = /^[a-z0-9_çğıöşü]{3,16}$/;

// V1 strict username regex — kullanıcı adı değiştirme akışı için
// server-side regex ile birebir aynı: sadece a-z, 0-9, alt çizgi.
const USERNAME_V1_REGEX = /^[a-z0-9_]{3,16}$/;

export const USERNAME_CHANGE_COST = 500;
export const USERNAME_CHANGE_COOLDOWN_DAYS = 14;

// V1'de yasaklı sabit isim listesi. Server da aynı listeyi kontrol eder;
// burada client tarafında erken uyarı için tutuyoruz.
const USERNAME_RESERVED: ReadonlySet<string> = new Set([
  "admin",
  "administrator",
  "moderator",
  "mod",
  "system",
  "sistem",
  "torble",
  "bot",
  "npc",
  "test",
  "support",
  "destek",
  "official",
  "owner",
  "root",
  "staff",
  "null",
  "undefined",
  "geoquiz",
  "geo_quiz",
  "developer",
  "dev",
  "yetkili",
  "kurucu",
  "yonetici",
  "help",
  "helper",
]);

export function normalizeUsernameV1(raw: string): string {
  let v = (raw ?? "").trim();
  if (v.startsWith("@")) v = v.slice(1);
  return v.toLowerCase();
}

/**
 * Yeni kullanıcı adı değiştirme akışı için V1 client validation.
 * Server-side change_username RPC ile birebir aynı kuralları uygular;
 * UI'da canlı feedback için kullanılır. Asıl otorite RPC'dir.
 */
export function validateUsernameV1(raw: string): string | null {
  const v = normalizeUsernameV1(raw);

  if (v.length === 0) {
    return "Kullanıcı adı boş olamaz.";
  }
  if (v.length < 3) {
    return "Kullanıcı adı en az 3 karakter olmalı.";
  }
  if (v.length > 16) {
    return "Kullanıcı adı en fazla 16 karakter olabilir.";
  }
  if (!USERNAME_V1_REGEX.test(v)) {
    return "Sadece küçük harf (a-z), rakam ve alt çizgi (_) kullanılabilir.";
  }
  if (USERNAME_RESERVED.has(v)) {
    return "Bu kullanıcı adı kullanılamaz.";
  }

  const lowerBanned = BANNED_USERNAME_WORDS.some((w) => v.includes(w));
  if (lowerBanned) {
    return "Bu kullanıcı adı kullanılamaz.";
  }

  return null;
}

export type ChangeUsernameResult =
  | {
      ok: true;
      username: string;
      gold: number;
      was_first: boolean;
      cost: number;
    }
  | {
      ok: false;
      code: string;
      message: string;
      days_left?: number;
      cost?: number;
      gold?: number;
    };

/**
 * Server-side change_username RPC wrapper.
 * Client doğrudan profiles tablosunu UPDATE etmez — Gold düşmesi ve username
 * değiştirilmesi tek transaction içinde server'da yapılır.
 */
export async function callChangeUsername(
  rawUsername: string
): Promise<ChangeUsernameResult> {
  const cleaned = normalizeUsernameV1(rawUsername);
  const { data, error } = await supabase.rpc("change_username", {
    p_new_username: cleaned,
  });

  if (error) {
    return {
      ok: false,
      code: "network",
      message: error.message || "Bir hata oluştu, tekrar dene.",
    };
  }
  if (!data || typeof data !== "object") {
    return {
      ok: false,
      code: "bad_response",
      message: "Sunucu beklenmeyen bir cevap döndü.",
    };
  }
  return data as ChangeUsernameResult;
}


export function normalizeUsername(username: string) {
  return username.trim().toLocaleLowerCase("tr-TR");
}

export function validateUsername(usernameRaw: string): string | null {
  const username = normalizeUsername(usernameRaw);

  if (username.length < 3) {
    return "Kullanıcı adı en az 3 karakter olmalı.";
  }

  if (username.length > 16) {
    return "Kullanıcı adı en fazla 16 karakter olabilir.";
  }

  if (!USERNAME_REGEX.test(username)) {
    return "Sadece küçük harf, rakam, alt çizgi ve Türkçe karakter kullanabilirsin.";
  }

  const hasBannedWord = BANNED_USERNAME_WORDS.some((word) =>
    username.includes(word)
  );

  if (hasBannedWord) {
    return "Bu kullanıcı adı kullanılamaz.";
  }

  return null;
}

export async function signUpWithEmail(
  email: string,
  password: string,
  username: string
) {
  return supabase.auth.signUp({
    email: email.trim(),
    password,
    options: {
      emailRedirectTo: `${window.location.origin}/`,
      data: {
        username,
      },
    },
  });
}

export async function signInWithEmail(email: string, password: string) {
  return supabase.auth.signInWithPassword({
    email: email.trim(),
    password,
  });
}

export async function signInWithGoogle() {
  return supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: window.location.origin,
    },
  });
}

export async function signOut() {
  return supabase.auth.signOut();
}

export async function getCurrentUser() {
  const { data, error } = await supabase.auth.getUser();
  return { user: data.user, error };
}

export async function getProfile(userId: string) {
  return supabase
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .maybeSingle<Profile>();
}

export async function createProfile(userId: string, usernameRaw: string) {
  const username = normalizeUsername(usernameRaw);
  const validationError = validateUsername(username);

  if (validationError) {
    return { data: null, error: { message: validationError } };
  }

  return supabase
    .from("profiles")
    .insert({
      id: userId,
      username,
    })
    .select("*")
    .single<Profile>();
}

export async function updateUsername(userId: string, usernameRaw: string) {
  const username = normalizeUsername(usernameRaw);
  const validationError = validateUsername(username);

  if (validationError) {
    return { data: null, error: { message: validationError } };
  }

  return supabase
    .from("profiles")
    .update({
      username,
      updated_at: new Date().toISOString(),
    })
    .eq("id", userId)
    .select("*")
    .single<Profile>();
}