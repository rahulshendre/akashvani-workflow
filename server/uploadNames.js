/**
 * File names from uploads.
 *
 * A browser sends the name of an uploaded file as UTF-8, but the multipart parser
 * behind multer decodes header values as Latin-1, so "नमस्ते.mp4" reaches the
 * server as "à¤¨à¤®à¤¸à¥à¤¤à¥.mp4". That garbled name then became the file on disk, the
 * Drive episode folder and the Drive file name. This undoes it.
 */

/** Re-read a Latin-1 decoded name as the UTF-8 it really was. Plain ASCII, and anything that is not valid UTF-8, is left alone. */
export function fixUploadName(name) {
  if (typeof name !== 'string' || /^[\x00-\x7f]*$/.test(name)) return name;
  const decoded = Buffer.from(name, 'latin1').toString('utf8');
  return decoded.includes('�') ? name : decoded;
}

/** Wrap a multer fileFilter so file.originalname is correct before the filter, the storage or any route sees it. */
export function withUtf8Names(fileFilter = (_req, _file, cb) => cb(null, true)) {
  return (req, file, cb) => {
    file.originalname = fixUploadName(file.originalname);
    fileFilter(req, file, cb);
  };
}
