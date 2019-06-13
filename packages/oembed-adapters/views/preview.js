/** @jsx jsx */

import { jsx } from '@emotion/core';
import { useRef, useEffect } from 'react';

const Preview = ({ url, options }) => {
  let containerRef = useRef(null);

  useEffect(() => {
    if (!window.iframely) {
      import('@iframely/embed.js').then(() => {
        window.iframely.extendOptions({ key: options.clientApiKey });
        window.iframely.load(containerRef.current, url);
      });
    }
  }, [url]);

  return <div ref={containerRef} />;
};

export default Preview;
