import { NextRequest, NextResponse } from 'next/server';

const UNPROTECTED_PATHS = new Set(['/api/health']);

function unauthorizedResponse(): NextResponse {
  return new NextResponse('Authentication required', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="OpenReader", charset="UTF-8"',
    },
  });
}

function parseBasicAuthHeader(headerValue: string | null): { username: string; password: string } | null {
  if (!headerValue || !headerValue.startsWith('Basic ')) return null;

  const encoded = headerValue.slice(6).trim();
  if (!encoded) return null;

  let decoded = '';
  try {
    decoded = atob(encoded);
  } catch {
    return null;
  }

  const separatorIndex = decoded.indexOf(':');
  if (separatorIndex < 0) return null;

  return {
    username: decoded.slice(0, separatorIndex),
    password: decoded.slice(separatorIndex + 1),
  };
}

export function middleware(request: NextRequest) {
  const expectedUser = process.env.BASIC_AUTH_USER;
  const expectedPassword = process.env.BASIC_AUTH_PASSWORD;

  // Disabled unless both values are explicitly provided.
  if (!expectedUser || !expectedPassword) {
    return NextResponse.next();
  }

  if (UNPROTECTED_PATHS.has(request.nextUrl.pathname)) {
    return NextResponse.next();
  }

  const credentials = parseBasicAuthHeader(request.headers.get('authorization'));
  if (!credentials) {
    return unauthorizedResponse();
  }

  if (credentials.username !== expectedUser || credentials.password !== expectedPassword) {
    return unauthorizedResponse();
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    // Protect the app and API routes while skipping Next.js internals/static assets.
    '/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)',
  ],
};
