import Link from "next/link";

export default function NotFound() {
  return (
    <div className="grid min-h-[60vh] place-items-center text-center">
      <div>
        <p className="text-4xl font-semibold">404</p>
        <p className="mt-2 text-muted-foreground">Halaman tidak ditemukan.</p>
        <Link href="/" className="mt-4 inline-block text-sm font-medium text-primary hover:underline">
          Kembali ke dashboard
        </Link>
      </div>
    </div>
  );
}
