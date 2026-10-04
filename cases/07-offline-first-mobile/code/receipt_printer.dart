import 'dart:io';
import 'dart:typed_data';

import 'package:esc_pos_utils_plus/esc_pos_utils_plus.dart';
import 'package:image/image.dart' as img;
import 'package:printing/printing.dart';

/// Raw ESC/POS over the network (the usual 9100 port).
///
/// A receipt here is a right-to-left document, and cheap thermal printers
/// cannot shape Arabic themselves. So the receipt is rendered to PDF with the
/// app's own font, rasterised to a bitmap, and streamed to the head as a
/// bitmap. Text mode is never used for the body.
///
/// Raw USB (OTG / bulk endpoints without an OS driver) is deliberately out of
/// scope: it needs a platform USB host API and per-chipset quirks, so it is
/// tracked as its own phase rather than smuggled in behind this function.
bool get isLanEscposTransportAvailable => true;

Future<void> printReceiptOverLan({
  required final Uint8List pdfBytes,
  required final String host,
  final int port = 9100,
  final Duration socketTimeout = const Duration(seconds: 8),
  final double rasterDpi = 203,
}) async {
  final profile = await CapabilityProfile.load();
  final generator = Generator(PaperSize.mm80, profile);

  final info = await Printing.info();
  if (!info.canRaster) {
    throw StateError('Raster output is unavailable on this platform.');
  }

  // `ESC @` resets the head. `ESC 3 24` sets the line feed to 24 dots, which
  // is exactly one raster row at single density, so consecutive strips stack
  // with no seam between them.
  final bytes = <int>[...generator.reset(), 0x1B, 0x33, 24];

  var pages = 0;
  await for (final page in Printing.raster(pdfBytes, dpi: rasterDpi)) {
    pages++;
    var image = page.asImage();
    final targetWidth = PaperSize.mm80.width;
    if (image.width != targetWidth) {
      image = img.copyResize(
        image,
        width: targetWidth,
        interpolation: img.Interpolation.linear,
      );
    }
    bytes.addAll(_rasterStrips(generator, _flattenOnWhite(image)));
  }
  if (pages == 0) {
    throw StateError('The PDF produced no raster output.');
  }

  bytes.addAll(generator.feed(3));
  bytes.addAll(generator.cut());

  final socket = await Socket.connect(host, port, timeout: socketTimeout);
  try {
    socket.add(Uint8List.fromList(bytes));
    await socket.flush();
  } finally {
    await socket.close();
  }
}

Future<void> probePrinterConnection({
  required final String host,
  final int port = 9100,
  final Duration socketTimeout = const Duration(seconds: 5),
}) async {
  final socket = await Socket.connect(host, port, timeout: socketTimeout);
  await socket.close();
}

/// Paints the source onto opaque white.
///
/// The platform PDF rasteriser renders an untouched page as fully transparent
/// RGBA (0, 0, 0, 0). The encoder below turns a bitmap into dots with
/// `grayscale → invert → threshold`, and it reads transparent black as "ink".
/// The result is a receipt that prints as a solid black rectangle. Flattening
/// first replaces transparency with real white pixels before the encoder ever
/// sees the image.
img.Image _flattenOnWhite(final img.Image source) {
  final canvas = img.Image(
    width: source.width,
    height: source.height,
    numChannels: 4,
  );
  img.fill(canvas, color: img.ColorRgba8(255, 255, 255, 255));
  img.compositeImage(canvas, source);
  return canvas;
}

/// Emits the bitmap as `GS v 0` (legacy raster) in vertical strips.
///
/// Two hardware realities drive the shape:
///
/// 1. Many low-cost 80 mm heads do not implement the newer `GS ( L` graphics
///    command. When they do not, they fall back to text mode and print the
///    command bytes as literal ASCII — the "random letters at the top of the
///    receipt". `GS v 0` is the command every ESC/POS head understands.
///
/// 2. Both encodings carry the row count in a two-byte field, so the format
///    allows 65535 rows. The actual buffer on a cheap head is far smaller.
///    Sending roughly 256 rows at a time lets the head flush each strip before
///    the next arrives, which is the difference between a long receipt that
///    prints and one that silently truncates.
List<int> _rasterStrips(
  final Generator generator,
  final img.Image image, {
  final int stripRows = 256,
}) {
  final out = <int>[];
  for (var y = 0; y < image.height; y += stripRows) {
    final height =
        (y + stripRows > image.height) ? image.height - y : stripRows;
    final strip = img.copyCrop(
      image,
      x: 0,
      y: y,
      width: image.width,
      height: height,
    );
    out.addAll(
      generator.imageRaster(
        strip,
        align: PosAlign.center,
        highDensityHorizontal: true,
        highDensityVertical: true,
        imageFn: PosImageFn.bitImageRaster,
      ),
    );
  }
  return out;
}
