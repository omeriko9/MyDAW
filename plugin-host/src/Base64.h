#pragma once
//
// plugin-host/src/Base64.h
//
// Small header-only base64 encode/decode used for the §8.2 control-pipe
// state messages (getState → {chunkB64}, setState {chunkB64}). Standard
// alphabet with '=' padding; decode tolerates embedded whitespace.
//
#include <cstdint>
#include <string>
#include <vector>

namespace mydaw {

inline std::string base64Encode(const uint8_t* data, size_t len) {
  static const char* kAlpha =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out;
  out.reserve(((len + 2) / 3) * 4);
  size_t i = 0;
  while (i + 3 <= len) {
    const uint32_t v = (uint32_t(data[i]) << 16) | (uint32_t(data[i + 1]) << 8) |
                       uint32_t(data[i + 2]);
    out.push_back(kAlpha[(v >> 18) & 63]);
    out.push_back(kAlpha[(v >> 12) & 63]);
    out.push_back(kAlpha[(v >> 6) & 63]);
    out.push_back(kAlpha[v & 63]);
    i += 3;
  }
  const size_t rem = len - i;
  if (rem == 1) {
    const uint32_t v = uint32_t(data[i]) << 16;
    out.push_back(kAlpha[(v >> 18) & 63]);
    out.push_back(kAlpha[(v >> 12) & 63]);
    out.push_back('=');
    out.push_back('=');
  } else if (rem == 2) {
    const uint32_t v = (uint32_t(data[i]) << 16) | (uint32_t(data[i + 1]) << 8);
    out.push_back(kAlpha[(v >> 18) & 63]);
    out.push_back(kAlpha[(v >> 12) & 63]);
    out.push_back(kAlpha[(v >> 6) & 63]);
    out.push_back('=');
  }
  return out;
}

inline std::string base64Encode(const std::vector<uint8_t>& data) {
  return base64Encode(data.data(), data.size());
}

// Returns false on any character outside the base64 alphabet (whitespace is
// skipped) or on a malformed final quantum.
inline bool base64Decode(const std::string& in, std::vector<uint8_t>& out) {
  auto val = [](char c) -> int {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+') return 62;
    if (c == '/') return 63;
    return -1;
  };
  out.clear();
  out.reserve((in.size() / 4) * 3);
  uint32_t acc = 0;
  int bits = 0;
  bool sawPad = false;
  for (char c : in) {
    if (c == ' ' || c == '\t' || c == '\r' || c == '\n') continue;
    if (c == '=') {
      sawPad = true;
      continue;
    }
    if (sawPad) return false; // data after padding
    const int v = val(c);
    if (v < 0) return false;
    acc = (acc << 6) | uint32_t(v);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push_back(uint8_t((acc >> bits) & 0xFF));
    }
  }
  // A valid stream leaves 0, 2 (one pad) or 4 (two pads) residual bits, all 0.
  if (bits == 6) return false;
  return true;
}

} // namespace mydaw
