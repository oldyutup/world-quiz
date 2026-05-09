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
};

const USERNAME_REGEX = /^[a-z0-9_çğıöşü]{3,16}$/;


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

export async function signUpWithEmail(email: string, password: string) {
  return supabase.auth.signUp({
    email: email.trim(),
    password,
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