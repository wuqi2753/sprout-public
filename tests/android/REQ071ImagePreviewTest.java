// REQ-071: seeded two-image debug fixture, 1080 x 2376 Android device.
import android.graphics.Point;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import com.android.uiautomator.core.UiObject;
import com.android.uiautomator.core.UiSelector;
import com.android.uiautomator.testrunner.UiAutomatorTestCase;
import java.io.File;

public class REQ071ImagePreviewTest extends UiAutomatorTestCase {
  int orangePixels(String name) {
    File file = new File("/sdcard/req-071-" + name + ".png");
    assertTrue(getUiDevice().takeScreenshot(file));
    Bitmap picture = BitmapFactory.decodeFile(file.getPath());
    int count = 0;
    for (int y = 300; y < picture.getHeight()-150; y += 3) for (int x = 0; x < picture.getWidth(); x += 3) {
      int pixel = picture.getPixel(x,y);
      int red = (pixel >> 16) & 255, green = (pixel >> 8) & 255, blue = pixel & 255;
      if (red > 180 && green > 40 && green < 230 && blue < 120 && red > green) count++;
    }
    picture.recycle();
    System.out.println("ORANGE " + name + " " + count);
    return count;
  }
  void pinch(UiObject screen, int start, int end) throws Exception {
    assertTrue(screen.performTwoPointerGesture(new Point(540-start,1100),new Point(540+start,1100),new Point(540-end,1100),new Point(540+end,1100),100));
    sleep(500);
  }
  public void testPinch() throws Exception {
    UiObject close = new UiObject(new UiSelector().description("关闭图片预览"));
    if (!close.exists()) {
      UiObject thumbnail = new UiObject(new UiSelector().description("全屏查看第 1 张图片，共 2 张"));
      if (!thumbnail.exists()) { getUiDevice().pressBack(); sleep(500); }
      assertTrue("Test image thumbnail must be visible", thumbnail.exists());
      thumbnail.click(); sleep(700);
    }
    assertTrue("Preview must be open", close.exists());
    int original = orangePixels("before");
    UiObject screen = new UiObject(new UiSelector().packageName("com.nativeinstant.app.timepreview").className("android.widget.FrameLayout").instance(0));
    pinch(screen,100,400);
    assertTrue("Pinch must not dismiss preview", close.exists());
    assertTrue("Pinch must not turn page", new UiObject(new UiSelector().text("1 / 2")).exists());
    int enlarged = orangePixels("after");
    assertTrue("Image must visibly enlarge", enlarged > original * 2);
    getUiDevice().swipe(300,1200,700,1400,60); sleep(500);
    assertTrue("Drag must not turn page", new UiObject(new UiSelector().text("1 / 2")).exists());
    orangePixels("dragged");
    pinch(screen,100,400);
    orangePixels("maximum");
    pinch(screen,400,50);
    pinch(screen,400,50);
    int restored = orangePixels("restored");
    assertTrue("Pinch in must restore fit", Math.abs(restored-original) < original * 0.12);
    getUiDevice().swipe(900,1200,150,1200,60); sleep(800);
    assertTrue("Original fit must allow page 2", new UiObject(new UiSelector().text("2 / 2")).exists());
    getUiDevice().swipe(150,1200,900,1200,60); sleep(800);
    assertTrue("Must return to page 1", new UiObject(new UiSelector().text("1 / 2")).exists());
    assertTrue("Page switch resets fit", Math.abs(orangePixels("page-reset")-original) < original * 0.12);
    close.click(); sleep(500);
    assertFalse("Close button must exit preview", close.exists());
    new UiObject(new UiSelector().description("全屏查看第 1 张图片，共 2 张")).click(); sleep(700);
    assertTrue("Reopen resets fit", Math.abs(orangePixels("reopened")-original) < original * 0.12);
    getUiDevice().pressBack(); sleep(500);
    assertFalse("Back must exit preview", close.exists());
  }
}
